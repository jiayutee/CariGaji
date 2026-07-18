import { getFederalHolidaySet, HOLIDAY_SOURCE_VERSION, isFederalHoliday } from "./federalHolidays.js";

const toIsoDate = (date) => date.toISOString().slice(0, 10);

const isWeekend = (date) => {
  const day = date.getUTCDay();
  return day === 0 || day === 6;
};

const isBusinessDay = (date, holidaySet) => {
  const dateStr = toIsoDate(date);
  return !isWeekend(date) && !isFederalHoliday(dateStr, holidaySet);
};

export const computeAdjustedPayDate = (year, monthIndex) => {
  const nominal = new Date(Date.UTC(year, monthIndex, 15));
  const holidaySet = getFederalHolidaySet(year);

  return computeAdjustedPayDateForNominalDate(nominal, holidaySet);
};

export const computeAdjustedPayDateForNominalDate = (nominalDate, holidaySet) => {
  const nominal = new Date(nominalDate);

  if (isBusinessDay(nominal, holidaySet)) {
    return {
      nominalPayDate: toIsoDate(nominal),
      adjustedPayDate: toIsoDate(nominal),
      adjustmentReason: "none",
      holidaySourceVersion: HOLIDAY_SOURCE_VERSION,
    };
  }

  // Tie-break policy: prefer earlier business day when distances are equal.
  for (let offset = 1; offset <= 7; offset += 1) {
      const previous = new Date(nominal);
      previous.setUTCDate(previous.getUTCDate() - offset);
    if (isBusinessDay(previous, holidaySet)) {
      return {
        nominalPayDate: toIsoDate(nominal),
        adjustedPayDate: toIsoDate(previous),
        adjustmentReason: isWeekend(nominal) ? "weekend" : "federal_holiday",
        holidaySourceVersion: HOLIDAY_SOURCE_VERSION,
      };
    }

      const next = new Date(nominal);
      next.setUTCDate(next.getUTCDate() + offset);
    if (isBusinessDay(next, holidaySet)) {
      return {
        nominalPayDate: toIsoDate(nominal),
        adjustedPayDate: toIsoDate(next),
        adjustmentReason: isWeekend(nominal) ? "weekend" : "federal_holiday",
        holidaySourceVersion: HOLIDAY_SOURCE_VERSION,
      };
    }
  }

  return {
    nominalPayDate: toIsoDate(nominal),
    adjustedPayDate: toIsoDate(nominal),
    adjustmentReason: "none",
    holidaySourceVersion: HOLIDAY_SOURCE_VERSION,
  };
};

const toCycleMonth = (year, monthIndex) => {
  const month = String(monthIndex + 1).padStart(2, "0");
  return `${year}-${month}`;
};

const hasRequiredVerifiedBanking = (record, role) => {
  if (!record) return false;
  if (record.role !== role) return false;
  if (record.verification_status !== "verified") return false;
  if (role === "employer" && !record.funding_ready) return false;
  return true;
};

const createAuditEntry = async (supabase, entry) => {
  const { error } = await supabase.from("payout_audit").insert(entry);
  if (error) {
    // Ignore audit insert failures in v1 UI flow to avoid blocking scheduler.
    console.warn("Failed to insert payout audit entry", error.message);
  }
};

export const runInternalPayoutScheduling = async (supabase, runForDate = new Date()) => {
  const year = runForDate.getUTCFullYear();
  const monthIndex = runForDate.getUTCMonth();
  const cycleMonth = toCycleMonth(year, monthIndex);

  const dateInfo = computeAdjustedPayDate(year, monthIndex);

  const cyclePayload = {
    cycle_month: cycleMonth,
    nominal_pay_date: dateInfo.nominalPayDate,
    adjusted_pay_date: dateInfo.adjustedPayDate,
    adjustment_reason: dateInfo.adjustmentReason,
    holiday_source_version: dateInfo.holidaySourceVersion,
    status: "generated",
  };

  const { data: cycle, error: cycleError } = await supabase
    .from("payout_cycle")
    .upsert(cyclePayload, { onConflict: "cycle_month" })
    .select()
    .single();

  if (cycleError) {
    throw new Error(`Unable to upsert payout cycle: ${cycleError.message}`);
  }

  const { data: candidateRows, error: candidateError } = await supabase
    .from("applications")
    .select("id, worker_id, shift_id, wage_ask, status, cancellation_choice, shift:shifts(id, employer_id, start_at, status)")
    .eq("status", "accepted");

  if (candidateError) {
    throw new Error(`Unable to load payout candidates: ${candidateError.message}`);
  }

  // Cancelled shifts are paid out separately by the cancellation trigger
  // (idempotency_key 'cancellation:<application_id>', see
  // 20260717h_fix_cancellation_payout_hours_and_tz.sql) using a reduced
  // amount based on cancellation_choice. That key lives in a different
  // namespace from this scheduler's '<cycleMonth>:<application_id>' key,
  // so 'on conflict' never dedupes between them -- without this exclusion
  // a cancelled shift's still-'accepted' application would also get a
  // full-wage payout_item here, on top of the correct reduced one.
  const candidates = (candidateRows || []).filter((row) => {
    if (row.shift?.status === "cancelled" || row.cancellation_choice) return false;
    const shiftDate = row.shift?.start_at ? new Date(row.shift.start_at) : null;
    if (!shiftDate) return false;
    return shiftDate.getUTCFullYear() === year && shiftDate.getUTCMonth() === monthIndex;
  });

  if (candidates.length === 0) {
    return { cycle, created: 0, held: 0, ready: 0 };
  }

  const userIds = new Set();
  candidates.forEach((row) => {
    if (row.worker_id) userIds.add(row.worker_id);
    if (row.shift?.employer_id) userIds.add(row.shift.employer_id);
  });

  const { data: bankRows, error: bankError } = await supabase
    .from("banking_details")
    .select("user_id, role, verification_status, funding_ready")
    .in("user_id", Array.from(userIds));

  if (bankError) {
    throw new Error(`Unable to load banking details: ${bankError.message}`);
  }

  const bankMap = (bankRows || []).reduce((acc, row) => {
    const key = `${row.user_id}:${row.role}`;
    acc[key] = row;
    return acc;
  }, {});

  let held = 0;
  let ready = 0;

  for (const row of candidates) {
    const workerId = row.worker_id;
    const employerId = row.shift?.employer_id;
    const workerBank = bankMap[`${workerId}:worker`];
    const employerBank = bankMap[`${employerId}:employer`];

    const workerEligible = hasRequiredVerifiedBanking(workerBank, "worker");
    const employerEligible = hasRequiredVerifiedBanking(employerBank, "employer");

    const amount = Number(row.wage_ask || 0);
    const status = workerEligible && employerEligible ? "ready" : "held";

    if (status === "held") held += 1;
    if (status === "ready") ready += 1;

    const holdReason = !workerEligible
      ? "worker_banking_not_verified"
      : !employerEligible
      ? "employer_banking_not_verified_or_funding_not_ready"
      : null;

    const payload = {
      payout_cycle_id: cycle.id,
      worker_id: workerId,
      employer_id: employerId,
      amount,
      currency: "MYR",
      scheduled_date: dateInfo.adjustedPayDate,
      status,
      source_refs: { application_id: row.id, shift_id: row.shift_id },
      idempotency_key: `${cycleMonth}:${row.id}`,
      error_code: holdReason,
      error_message: holdReason,
    };

    const { data: inserted, error: insertError } = await supabase
      .from("payout_item")
      .upsert(payload, { onConflict: "idempotency_key" })
      .select()
      .single();

    if (insertError) {
      throw new Error(`Unable to upsert payout item: ${insertError.message}`);
    }

    await createAuditEntry(supabase, {
      payout_item_id: inserted.id,
      actor_type: "system",
      action: "scheduler_upsert",
      from_status: null,
      to_status: status,
      notes: "Internal scheduler run",
      metadata_json: { cycle_month: cycleMonth },
    });
  }

  // TODO: Integrate real Malaysian bank transfer execution via pluggable adapter in transfer phase.
  return { cycle, created: candidates.length, held, ready };
};
