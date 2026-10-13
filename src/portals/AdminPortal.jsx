// Split out of carigaji-app.jsx so a visitor who never opens this portal never downloads it.
// Everything it shares with the rest of the app is imported from the main module.
import { useState, useEffect, useCallback } from "react";
import { supabase } from "../lib/supabase.js";
import { runInternalPayoutScheduling } from "../lib/payouts/scheduler.js";
import { createPortal } from "react-dom";
import { BRAND, Badge, Btn, Card, DISPUTE_CATEGORIES, EmptyState, FS, Icons, InlineIcon, KYC_BUCKET, Pill, RADIUS, SITE, Select, Stat, TYPE, Z, displayProtectedText, disputeStatusLabel, initialRouteSegments, mapPayoutPillColor, payoutHoldReasonLabel, payoutStatusLabel, routeKeyFromSegment, toCurrency, useDialog, useLanguage, usePortalRoute, useConfirm, useToast } from "../../carigaji-app.jsx";

// ─── ADMIN PORTAL ─────────────────────────────────────────────────────────────
// The admin sidebar is always dark -- BRAND.dark in light mode and dark mode
// alike -- so its type is fixed white at three weights rather than theme-aware.
// Named here so the intent is legible and the values cannot drift apart.
const ADMIN_SIDEBAR_TEXT  = "rgba(255,255,255,0.8)";
const ADMIN_SIDEBAR_MUTED = "rgba(255,255,255,0.55)";
const ADMIN_SIDEBAR_DIM   = "rgba(255,255,255,0.4)";
const ADMIN_SIDEBAR_RULE  = "rgba(255,255,255,0.2)";
const ADMIN_SIDEBAR_ON_DARK = "#fff";
const ADMIN_SIDEBAR_ACTIVE_BG = "rgba(232,56,13,0.15)";  // brand tint, on dark only

const AdminPortal = ({ onOpenPortal, compact = false, user = null }) => {
  const toast = useToast();
  const { t } = useLanguage();
  // Every action here changes someone's money, access or record. Each one asks
  // first (see useConfirm), and the ones the other side would want explained
  // take a note that is written somewhere a person can read it later.
  const [confirm, confirmDialog] = useConfirm();
  // Issue-report status picked in the dropdown but not saved yet. The select
  // used to write on change, so a mis-tap silently re-filed a report.
  const [issueStatusDrafts, setIssueStatusDrafts] = useState({});
  // Live rate from platform_fee_pct(); null until it loads (or if it fails),
  // so the Config screen never shows the fallback constant as if it were real.
  const [platformFeePct, setPlatformFeePct] = useState(null);
  useEffect(() => {
    let active = true;
    supabase.rpc('platform_fee_pct').then(({ data, error }) => {
      if (!active || error || data == null) return;
      setPlatformFeePct(Number(data));
    });
    return () => { active = false; };
  }, []);
  const [view, setView] = useState(() => parseAdminRoute(initialRouteSegments("admin")).view);
  usePortalRoute({ portal: "admin", head: { title: `Admin | ${SITE.name}`, description: t("seo.homeDescription"), index: false }, segments: buildAdminSegments({ view }), parse: parseAdminRoute, apply: (r) => setView(r.view) });
  // kycActions/flagActions were local-only "decisions" for the two mock queues;
  // both are gone now, and neither ever reached the database.
  const [livePayoutQueue, setLivePayoutQueue] = useState(null);
  const [payoutQueueShiftTitles, setPayoutQueueShiftTitles] = useState({}); // shift_id -> title
  const [payoutQueueWorkerNames, setPayoutQueueWorkerNames] = useState({}); // worker_id -> full_name
  const [payoutRunning, setPayoutRunning] = useState(false);
  const [payoutMessage, setPayoutMessage] = useState("");
  const [kycQueue, setKycQueue] = useState(null);
  const [employerQueue, setEmployerQueue] = useState(null);
  const [kycSignedUrls, setKycSignedUrls] = useState({});
  const [overviewStats, setOverviewStats] = useState(null);
  const [disputesQueue, setDisputesQueue] = useState(null);
  const [issueReportsQueue, setIssueReportsQueue] = useState(null);
  // Open-item counts for the sidebar. Each queue's list only loads when its
  // own tab (or Overview) opens, and the payout list is capped at 30 rows, so
  // none of them can be counted from what is already in memory. Instead one
  // head-only count per queue, using the same filter that queue's tab uses,
  // fetched on mount and again after any action that can close an item.
  const [navCounts, setNavCounts] = useState({});
  const refreshNavCounts = useCallback(async () => {
    if (!supabase) return;
    const head = { count: "exact", head: true };
    const [kyc, employers, disputes, reports, payouts] = await Promise.all([
      supabase.from("profiles").select("id", head).eq("kyc_level", "pending_review"),
      supabase.from("profiles").select("id", head).eq("employer_verification_status", "pending_review"),
      supabase.from("disputes").select("id", head).in("status", ["open", "under_review"]),
      supabase.from("issue_reports").select("id", head).in("status", ["new", "investigating"]),
      supabase.from("payout_item").select("id", head).in("status", ["queued", "ready", "scheduled"]),
    ]);
    // A failed count shows no chip rather than a wrong number.
    setNavCounts({
      kycqueue: kyc.error ? 0 : (kyc.count ?? 0),
      employerqueue: employers.error ? 0 : (employers.count ?? 0),
      disputes: disputes.error ? 0 : (disputes.count ?? 0),
      reports: reports.error ? 0 : (reports.count ?? 0),
      payouts: payouts.error ? 0 : (payouts.count ?? 0),
    });
  }, []);
  useEffect(() => { refreshNavCounts(); }, [refreshNavCounts]);
  // Disputes and Issue Reports lead with what is still open; closed items are
  // history and stay one tap away rather than mixed in by date.
  const [showClosedDisputes, setShowClosedDisputes] = useState(false);
  const [showClosedReports, setShowClosedReports] = useState(false);
  const isOpenDispute = (d) => d.status === "open" || d.status === "under_review";
  const isOpenReport = (r) => r.status === "new" || r.status === "investigating";
  const ISSUE_STATUS_LABEL_KEYS = {
    new: "admin.reportStatusNew",
    investigating: "admin.reportStatusInvestigating",
    resolved: "admin.reportStatusResolved",
    wont_fix: "admin.reportStatusWontFix",
    duplicate: "admin.reportStatusDuplicate",
  };
  const [issueNoteDrafts, setIssueNoteDrafts] = useState({}); // { [id]: text } -- unsent edits
  const [savingIssueReport, setSavingIssueReport] = useState(null); // id currently saving

  useEffect(() => {
    if (!supabase || (view !== "reports" && view !== "overview")) return;
    let active = true;
    (async () => {
      setIssueReportsQueue(null);
      const { data, error } = await supabase
        .from("issue_reports")
        .select("id, category, severity, description, page_context, reporter_role, status, admin_note, created_at")
        .order("created_at", { ascending: false });
      if (!active) return;
      setIssueReportsQueue(error ? [] : (data || []));
    })();
    return () => { active = false; };
  }, [view]);

  const saveIssueReport = async (reportId, status) => {
    const note = issueNoteDrafts[reportId];
    setSavingIssueReport(reportId);
    const patch = { status };
    if (note !== undefined) patch.admin_note = note;
    const { error } = await supabase.from("issue_reports").update(patch).eq("id", reportId);
    setSavingIssueReport(null);
    if (error) { toast(`${t("admin.reportSaveFailed")}${error.message}`, "error"); return; }
    setIssueReportsQueue(prev => (prev ?? []).map(r => r.id === reportId ? { ...r, ...patch } : r));
    setIssueStatusDrafts(prev => { const next = { ...prev }; delete next[reportId]; return next; });
    refreshNavCounts();
    toast(t("admin.reportSaved"), "success");
  };
  // Dispute currently open in the investigate/discuss panel, or null.
  const [disputeDetailFor, setDisputeDetailFor] = useState(null);
  const disputeDetailDialog = useDialog(Boolean(disputeDetailFor), () => setDisputeDetailFor(null), { label: t("admin.disputeInvestigateTitle") });
  const [disputeMessages, setDisputeMessages] = useState(null);
  const [disputeMessageInput, setDisputeMessageInput] = useState("");
  const [sendingDisputeMessage, setSendingDisputeMessage] = useState(false);
  const [disputeSenderNames, setDisputeSenderNames] = useState({});
  // Final say on an attendance dispute: settles the record itself, not just
  // the ticket. Outcome + hours + note go to admin_apply_attendance_correction.
  const [rulingOutcome, setRulingOutcome] = useState("grant_attendance");
  const [rulingHours, setRulingHours] = useState("");
  const [rulingNote, setRulingNote] = useState("");
  const [applyingRuling, setApplyingRuling] = useState(false);

  // Load the shift's chat history when the investigate panel opens. Same
  // room worker+employer already share (messages, recipient_id null) --
  // messages_admin_all lets admin read/write it without being a member.
  useEffect(() => {
    if (!disputeDetailFor?.application?.shift_id) { setDisputeMessages(null); return undefined; }
    let active = true;
    const shiftId = disputeDetailFor.application.shift_id;
    setDisputeMessages(null);
    supabase
      .from('messages')
      .select('id, sender_id, content, created_at')
      .eq('shift_id', shiftId)
      .is('recipient_id', null)
      .order('created_at', { ascending: true })
      .then(({ data }) => {
        if (!active) return;
        setDisputeMessages(data ?? []);
        const ids = [...new Set((data ?? []).map(m => m.sender_id))];
        if (!ids.length) return;
        supabase.from('profiles').select('id, full_name').in('id', ids).then(({ data: ps }) => {
          if (!active || !ps) return;
          setDisputeSenderNames(prev => ({ ...prev, ...Object.fromEntries(ps.map(p => [p.id, p.full_name || null])) }));
        });
      });
    return () => { active = false; };
  }, [disputeDetailFor]);

  const sendDisputeMessage = async () => {
    const shiftId = disputeDetailFor?.application?.shift_id;
    const content = disputeMessageInput.trim();
    if (!shiftId || !content || !user) return;
    setSendingDisputeMessage(true);
    const { data, error } = await supabase.from('messages').insert({
      shift_id: shiftId,
      sender_id: user.id,
      recipient_id: null, // group room -- both parties see the admin's message
      content,
    }).select('id, sender_id, content, created_at').single();
    setSendingDisputeMessage(false);
    if (error) { toast(t('admin.disputeChatSendFailed') + error.message, 'error'); return; }
    setDisputeMessageInput('');
    setDisputeMessages(prev => (prev ?? []).some(m => m.id === data.id) ? prev : [...(prev ?? []), data]);
  };

  const applyAttendanceRuling = async () => {
    if (!disputeDetailFor) return;
    const ok = await confirm({
      title: t("admin.confirmRulingTitle"),
      body: rulingOutcome === "grant_attendance" ? t("admin.confirmRulingGrant", { hours: rulingHours })
        : rulingOutcome === "confirm_no_show" ? t("admin.confirmRulingNoShow")
        : t("admin.confirmRulingReverse"),
      confirmLabel: t("admin.rulingApplyBtn"),
      tone: rulingOutcome === "confirm_no_show" ? "danger" : "primary",
    });
    if (!ok) return;
    setApplyingRuling(true);
    const { error } = await supabase.rpc("admin_apply_attendance_correction", {
      p_dispute_id: disputeDetailFor.id,
      p_outcome: rulingOutcome,
      p_hours: rulingOutcome === "grant_attendance" ? Number(rulingHours) : null,
      p_note: rulingNote.trim() || null,
    });
    setApplyingRuling(false);
    if (error) { toast(error.message, "error"); return; }
    setDisputesQueue(prev => (prev ?? []).map(d => d.id === disputeDetailFor.id ? { ...d, status: "resolved" } : d));
    setDisputeDetailFor(null);
    setRulingHours(""); setRulingNote(""); setRulingOutcome("grant_attendance");
    refreshNavCounts();
    toast(t("admin.rulingApplied"), "success");
  };

  const markDisputeUnderReview = async (disputeId) => {
    const { error } = await supabase.from("disputes")
      .update({ status: "under_review" })
      .eq("id", disputeId);
    if (error) { toast(`${t("admin.disputeUnderReviewFailed")}${error.message}`, "error"); return; }
    setDisputesQueue(prev => (prev ?? []).map(d => d.id === disputeId ? { ...d, status: "under_review" } : d));
    toast(t("admin.disputeUnderReviewSet"), "success");
  };
  // Deposits: recording a bank transfer an employer has actually made. The
  // ledger is append-only, so a mistyped amount can never be edited -- only
  // offset by another entry someone has to reason about later. That is why
  // this screen confirms before writing rather than after.
  const [depositEmployers, setDepositEmployers] = useState(null);
  const [depositSearch, setDepositSearch] = useState("");
  const [depositTarget, setDepositTarget] = useState(null);   // { id, full_name }
  const [depositAmount, setDepositAmount] = useState("");
  const [depositReference, setDepositReference] = useState("");
  const [depositConfirming, setDepositConfirming] = useState(false);
  const [depositSubmitting, setDepositSubmitting] = useState(false);
  const [depositResult, setDepositResult] = useState(null);   // last successful RPC payload
  const [depositRecent, setDepositRecent] = useState(null);
  // Basic analytics: event_type -> count, last 7 days (see
  // supabase/migrations/20260720_analytics_events.sql). null = loading,
  // [] = loaded but empty/unavailable (RLS denial or table missing pre-migration).
  const [analyticsCounts, setAnalyticsCounts] = useState(null);

  // {id, label} like the employer console (13565), NOT a plain string array.
  // The old version derived the route from the label itself --
  // `n.toLowerCase().replace(" ", "")` -- so the moment these strings were
  // translated, every nav button would have routed to a view id that does not
  // exist and the console would have rendered blank in BM and Chinese while
  // still working in English. The id is the route; the label is only ever shown.
  const navItems = [
    { id: "overview", label: t("admin.navOverview") },
    { id: "kycqueue", label: t("admin.navKycQueue") },
    { id: "employerqueue", label: t("admin.navEmployerQueue") },
    { id: "disputes", label: t("admin.navDisputes") },
    { id: "reports", label: t("admin.navReports") },
    { id: "flags", label: t("admin.navFlags") },
    { id: "payouts", label: t("admin.navPayouts") },
    { id: "deposits", label: t("admin.navDeposits") },
    { id: "config", label: t("admin.navConfig") },
  ];
  // Who is actually signed in. Only accounts carrying app_metadata.role='admin'
  // reach this screen, so the identity line shows the real name and the email
  // -- useful precisely because an operator may hold more than one account.
  const adminName = user?.user_metadata?.full_name || user?.user_metadata?.name || user?.email || "Admin";
  const adminEmail = user?.email || "";
  // Mobile: eight stacked full-width nav buttons filled the whole first screen
  // before any content appeared. Same drawer the employer console uses.
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const sidebarDialog = useDialog(sidebarOpen, () => setSidebarOpen(false), { label: t("nav.menuTitle") });

  // This queue used to render three INVENTED people -- names, risk scores and
  // "GPS mismatch" / "No-show (confirmed)" accusations -- through the same
  // Card/Badge treatment real records would use, with buttons claiming the
  // outcome was "logged to audit trail" when nothing was written anywhere. An
  // operator had no way to tell the fabrications from real cases, and could
  // suspend an account on the strength of one. Removed 2026-09-13.
  //
  // Nothing in the schema records GPS mismatches, QR token reuse or confirmed
  // no-shows, so there is no data source to point this at yet. It stays empty
  // until one exists: an empty queue is honest, sample accusations are not.
  const FLAGS = [];

  const loadPayoutQueue = async () => {
    const { data, error } = await supabase
      .from("payout_item")
      .select("id, worker_id, employer_id, amount, scheduled_date, status, source_refs, error_message, created_at")
      .order("created_at", { ascending: false })
      .limit(30);
    if (error) {
      setLivePayoutQueue(null);
      setPayoutMessage(`Unable to load payout queue: ${error.message}`);
      return;
    }
    setLivePayoutQueue(data || []);
    // Neither column is a real FK PostgREST can embed (source_refs is jsonb,
    // worker_id has no embed configured here) — without this the admin table
    // showed raw UUIDs for both "Worker" and "Shift" instead of a name/title.
    const shiftIds = [...new Set((data ?? []).map(p => p.source_refs?.shift_id).filter(Boolean))];
    const workerIds = [...new Set((data ?? []).map(p => p.worker_id).filter(Boolean))];
    const [{ data: shiftRows }, { data: workerRows }] = await Promise.all([
      shiftIds.length ? supabase.from("shifts").select("id, title").in("id", shiftIds) : Promise.resolve({ data: [] }),
      workerIds.length ? supabase.from("profiles").select("id, full_name").in("id", workerIds) : Promise.resolve({ data: [] }),
    ]);
    setPayoutQueueShiftTitles(Object.fromEntries((shiftRows ?? []).map(s => [s.id, s.title])));
    setPayoutQueueWorkerNames(Object.fromEntries((workerRows ?? []).map(w => [w.id, w.full_name])));
  };

  useEffect(() => {
    loadPayoutQueue();
  }, []);

  useEffect(() => {
    if (!supabase || (view !== "kycqueue" && view !== "overview")) return;
    (async () => {
      setKycQueue(null);
      const { data: pending, error } = await supabase
        .from("profiles")
        .select("id, full_name, kyc_level, created_at")
        .eq("kyc_level", "pending_review")
        .order("created_at", { ascending: true });
      if (error) { setKycQueue([]); return; }
      setKycQueue(pending || []);
    })();
  }, [view]);

  useEffect(() => {
    if (!supabase || view !== "deposits") return;
    (async () => {
      setDepositEmployers(null);
      const { data, error } = await supabase
        .from("profiles")
        .select("id, full_name, employer_verification_status")
        .eq("role", "employer")
        .order("full_name", { ascending: true });
      setDepositEmployers(error ? [] : (data || []));
      // Context for whoever is recording: what was last credited, so a
      // duplicate transfer is visible before it is entered rather than after
      // the unique idempotency key rejects it.
      const { data: recent, error: recentError } = await supabase
        .from("employer_wallet_entry")
        .select("id, employer_id, amount, note, created_at")
        .eq("kind", "topup")
        .order("created_at", { ascending: false })
        .limit(10);
      setDepositRecent(recentError ? [] : (recent || []));
    })();
  }, [view]);

  // Employer SSM verification queue — mirrors the KYC queue pattern. Rows
  // land here automatically: the guard trigger in
  // 20260712b_employer_verification.sql flips any non-admin SSM submission
  // to pending_review, and only an admin JWT may set verified/rejected.
  useEffect(() => {
    if (!supabase || (view !== "employerqueue" && view !== "overview")) return;
    (async () => {
      setEmployerQueue(null);
      const { data: pending, error } = await supabase
        .from("profiles")
        .select("id, full_name, ssm_number, ssm_document_path, employer_verification_status, created_at")
        .eq("employer_verification_status", "pending_review")
        .order("created_at", { ascending: true });
      if (error) { setEmployerQueue([]); return; }
      setEmployerQueue(pending || []);
    })();
  }, [view]);

  const setEmployerVerification = async (emp, status) => {
    const userId = emp.id;
    const verifying = status === "verified";
    const ok = await confirm({
      title: t(verifying ? "admin.confirmVerifyEmployerTitle" : "admin.confirmRejectEmployerTitle", { name: emp.full_name || "Unnamed company" }),
      body: t(verifying ? "admin.confirmVerifyEmployerBody" : "admin.confirmRejectEmployerBody"),
      confirmLabel: t(verifying ? "admin.confirmVerifyBtn" : "admin.confirmRejectBtn"),
      tone: verifying ? "success" : "danger",
    });
    if (!ok) return;
    const { error } = await supabase.from("profiles").update({ employer_verification_status: status }).eq("id", userId);
    if (error) { toast(`Failed to update: ${error.message}`, "error"); return; }
    setEmployerQueue(prev => (prev ?? []).filter(u => u.id !== userId));
    refreshNavCounts();
    toast(status === "verified" ? "Employer verified." : "Employer verification rejected.", "success");
  };

  useEffect(() => {
    if (!supabase || (view !== "disputes" && view !== "overview")) return;
    (async () => {
      setDisputesQueue(null);
      const { data, error } = await supabase
        .from("disputes")
        .select("id, category, description, status, admin_notes, created_at, application:applications(id, worker_id, wage_ask, checked_in_at, checked_out_at, checked_in_method, checked_out_method, worker_reported_hours, no_show_at, no_show_note, employer_hours_confirmed_at, worker_signed_at, employer_signed_at, shift_id, worker:profiles!applications_worker_id_profiles_fkey(full_name), shift:shifts(title, employer_id, wage_min, wage_max, start_at, end_at, employer:profiles(full_name)))")
        .order("created_at", { ascending: false });
      if (error) { setDisputesQueue([]); return; }
      setDisputesQueue(data || []);
    })();
  }, [view]);

  useEffect(() => {
    if (!supabase || view !== "overview") return;
    let active = true;
    (async () => {
      setOverviewStats(null);
      const dayStart = new Date();
      dayStart.setHours(0, 0, 0, 0);
      const dayEnd = new Date(dayStart);
      dayEnd.setDate(dayEnd.getDate() + 1);

      const [openShiftsRes, fillShiftsRes, workersRes, employersRes, todayShiftsRes] = await Promise.all([
        supabase.from("shifts").select("id").eq("status", "open"),
        supabase.from("shifts").select("headcount, filled_count").in("status", ["open", "filled", "completed"]),
        supabase.from("profiles").select("id").eq("role", "worker"),
        supabase.from("profiles").select("id").eq("role", "employer"),
        supabase.from("shifts").select("id")
          .in("status", ["open", "filled", "completed"])
          .gte("start_at", dayStart.toISOString())
          .lt("start_at", dayEnd.toISOString()),
      ]);
      if (!active) return;

      const fillShifts = fillShiftsRes.data || [];
      const totalHeadcount = fillShifts.reduce((sum, s) => sum + (s.headcount || 0), 0);
      const totalFilled = fillShifts.reduce((sum, s) => sum + (s.filled_count || 0), 0);

      setOverviewStats({
        openShifts: openShiftsRes.data?.length ?? null,
        fillRatePct: totalHeadcount > 0 ? Math.round((totalFilled / totalHeadcount) * 100) : null,
        activeWorkers: workersRes.data?.length ?? null,
        registeredEmployers: employersRes.data?.length ?? null,
        shiftsToday: todayShiftsRes.data?.length ?? null,
      });
    })();
    return () => { active = false; };
  }, [view]);

  // Basic analytics: event_type -> count over the trailing 7 days (see
  // supabase/migrations/20260720_analytics_events.sql). Aggregated server-side
  // via the analytics_event_counts RPC (a plain SQL function, RLS still
  // applies since it runs as SECURITY INVOKER) rather than pulling raw rows —
  // pulling raw rows would silently under-count once volume passes
  // PostgREST's default row cap. Any query failure (RLS denial, or the
  // migration not having run yet) degrades to an empty list rather than
  // surfacing an error.
  useEffect(() => {
    if (!supabase || view !== "overview") return;
    let active = true;
    (async () => {
      setAnalyticsCounts(null);
      const sevenDaysAgo = new Date();
      sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
      const { data, error } = await supabase
        .rpc("analytics_event_counts", { since: sevenDaysAgo.toISOString() });
      if (!active) return;
      if (error) { setAnalyticsCounts([]); return; }

      setAnalyticsCounts((data || []).map(row => ({ eventType: row.event_type, count: row.count })));
    })();
    return () => { active = false; };
  }, [view]);

  const updatePayoutStatus = async (item, nextStatus) => {
    const name = (item.worker_id && payoutQueueWorkerNames[item.worker_id]) || t("admin.unnamedWorker");
    const amount = toCurrency(item.amount);
    const releasing = nextStatus === "processed_internal";
    const ok = await confirm(releasing ? {
      title: t("admin.confirmReleaseTitle", { amount, name }),
      body: t("admin.confirmReleaseBody"),
      confirmLabel: t("admin.confirmReleaseBtn"),
      tone: "success",
    } : {
      title: t("admin.confirmHoldTitle", { amount, name }),
      body: t("admin.confirmHoldBody"),
      confirmLabel: t("admin.confirmHoldBtn"),
      tone: "danger",
      note: { label: t("admin.confirmHoldNote"), required: true },
    });
    if (!ok) return;
    const { error } = await supabase
      .from("payout_item")
      .update({ status: nextStatus })
      .eq("id", item.id);
    if (error) {
      setPayoutMessage(`Failed to update payout item: ${error.message}`);
      return;
    }

    await supabase.from("payout_audit").insert({
      payout_item_id: item.id,
      actor_type: "admin",
      actor_id: user?.id ?? null,
      action: "manual_status_update",
      from_status: item.status,
      to_status: nextStatus,
      notes: ok.note || "Admin action from payout queue",
      metadata_json: { source: "admin_portal" },
    });

    setPayoutMessage(`Payout ${item.id} moved to ${nextStatus}.`);
    await loadPayoutQueue();
    refreshNavCounts();
  };

  const runScheduler = async () => {
    if (!user) {
      setPayoutMessage("You must be signed in to run the scheduler.");
      return;
    }
    setPayoutRunning(true);
    setPayoutMessage("");
    try {
      const result = await runInternalPayoutScheduling(supabase);
      setPayoutMessage(`Scheduler completed. Created ${result.created}, ready ${result.ready}, held ${result.held}.`);
      await loadPayoutQueue();
      refreshNavCounts();
    } catch (error) {
      setPayoutMessage(error.message);
    }
    setPayoutRunning(false);
  };

  const loadKycDocuments = async (userId) => {
    if (kycSignedUrls[userId]) return;
    const { data: files, error: listError } = await supabase.storage
      .from("kyc-documents")
      .list(userId, { limit: 20 });
    if (listError) { toast("Could not load documents.", "error"); return; }
    if (!files?.length) { setKycSignedUrls(prev => ({ ...prev, [userId]: {} })); return; }
    const urls = {};
    await Promise.all(files.map(async (file) => {
      const { data, error: urlErr } = await supabase.storage
        .from("kyc-documents")
        .createSignedUrl(`${userId}/${file.name}`, 3600);
      if (urlErr) return;
      if (data?.signedUrl) urls[file.name] = data.signedUrl;
    }));
    setKycSignedUrls(prev => ({ ...prev, [userId]: urls }));
  };

  const approveKyc = async (worker, level = "Standard") => {
    const userId = worker.id;
    const docsOpened = Boolean(kycSignedUrls[userId]);
    const ok = await confirm({
      title: t("admin.confirmApproveKycTitle", { name: worker.full_name || "Unnamed user", level }),
      body: [level === "Advanced" ? t("admin.confirmApproveAdvancedBody") : t("admin.confirmApproveStandardBody"),
             docsOpened ? null : t("admin.confirmDocsNotOpened")].filter(Boolean).join("\n\n"),
      confirmLabel: t("admin.confirmApproveBtn"),
      tone: "success",
    });
    if (!ok) return;
    const { error } = await supabase.from("profiles").update({ kyc_level: level }).eq("id", userId);
    if (error) { toast(`Failed to approve KYC: ${error.message}`, "error"); return; }
    setKycQueue(prev => prev.filter(u => u.id !== userId));
    setKycSignedUrls(prev => { const next = { ...prev }; delete next[userId]; return next; });
    refreshNavCounts();
    toast(`KYC approved — level set to ${level}`, "success");
  };

  const rejectKyc = async (worker) => {
    const userId = worker.id;
    const ok = await confirm({
      title: t("admin.confirmRejectKycTitle", { name: worker.full_name || "Unnamed user" }),
      body: t("admin.confirmRejectKycBody"),
      confirmLabel: t("admin.confirmRejectBtn"),
      tone: "danger",
    });
    if (!ok) return;
    const { error } = await supabase.from("profiles").update({ kyc_level: "Basic" }).eq("id", userId);
    if (error) { toast(`Failed to reject KYC: ${error.message}`, "error"); return; }
    setKycQueue(prev => prev.filter(u => u.id !== userId));
    setKycSignedUrls(prev => { const next = { ...prev }; delete next[userId]; return next; });
    refreshNavCounts();
    toast("KYC rejected — user reset to Basic", "info");
  };

  const withAdminNote = (existing, note) => (note ? (existing ? `${existing}\n${note}` : note) : existing ?? null);
  const resolveDispute = async (dispute) => {
    const disputeId = dispute.id;
    const ok = await confirm({
      title: t("admin.confirmResolveTitle"),
      body: t("admin.confirmResolveBody"),
      confirmLabel: t("admin.disputeResolve"),
      tone: "success",
      note: { label: t("admin.confirmResolveNote") },
    });
    if (!ok) return;
    const resolvedAt = new Date().toISOString();
    const adminNotes = withAdminNote(dispute.admin_notes, ok.note);
    const { error } = await supabase.from("disputes")
      .update({ status: "resolved", resolved_by: user?.id ?? null, resolved_at: resolvedAt, admin_notes: adminNotes })
      .eq("id", disputeId);
    if (error) { toast(`${t("admin.disputeResolveFailed")}${error.message}`, "error"); return; }
    setDisputesQueue(prev => (prev ?? []).map(d => d.id === disputeId ? { ...d, status: "resolved", resolved_at: resolvedAt, admin_notes: adminNotes } : d));
    refreshNavCounts();
    toast(t("admin.disputeResolved"), "success");
  };

  const submitDeposit = async () => {
    if (!depositTarget || depositSubmitting) return;
    const amount = Number(depositAmount);
    const reference = depositReference.trim();
    // The RPC enforces all of this too. Checking here as well is not
    // duplication for its own sake: it keeps the confirm dialog from promising
    // a write that the database is going to refuse.
    if (!Number.isFinite(amount) || amount <= 0) { toast(t("admin.depositAmountInvalid"), "error"); return; }
    if (!reference) { toast(t("admin.depositReferenceRequired"), "error"); return; }

    setDepositSubmitting(true);
    const { data, error } = await supabase.rpc("admin_record_topup", {
      p_employer_id: depositTarget.id,
      p_amount: amount,
      p_reference: reference,
    });
    setDepositSubmitting(false);
    setDepositConfirming(false);

    if (error) {
      // A repeated reference is the expected mistake, not an edge case: the
      // ledger keys idempotency on 'topup:<reference>' precisely so the same
      // bank transfer cannot be credited twice. Say that, rather than showing
      // a raw unique-violation.
      const duplicate = /duplicate key|idempotency/i.test(error.message || "");
      toast(duplicate ? t("admin.depositDuplicate", { reference }) : `${t("admin.depositFailed")}${error.message}`, "error");
      return;
    }

    const payload = Array.isArray(data) ? data[0] : data;
    setDepositResult({ ...payload, employer_name: depositTarget.full_name });
    setDepositAmount("");
    setDepositReference("");
    setDepositRecent(prev => ([
      { id: `local-${reference}`, employer_id: depositTarget.id, amount, note: `Bank transfer ${reference}`, created_at: new Date().toISOString() },
      ...(prev || []),
    ]));
    toast(t("admin.depositRecorded", { amount: amount.toFixed(2), name: depositTarget.full_name }), "success");
  };

  const dismissDispute = async (dispute) => {
    const disputeId = dispute.id;
    const ok = await confirm({
      title: t("admin.confirmDismissTitle"),
      body: t("admin.confirmDismissBody"),
      confirmLabel: t("admin.disputeDismiss"),
      tone: "danger",
      note: { label: t("admin.confirmDismissNote"), required: true },
    });
    if (!ok) return;
    const resolvedAt = new Date().toISOString();
    const adminNotes = withAdminNote(dispute.admin_notes, ok.note);
    const { error } = await supabase.from("disputes")
      .update({ status: "dismissed", resolved_by: user?.id ?? null, resolved_at: resolvedAt, admin_notes: adminNotes })
      .eq("id", disputeId);
    if (error) { toast(`${t("admin.disputeDismissFailed")}${error.message}`, "error"); return; }
    setDisputesQueue(prev => (prev ?? []).map(d => d.id === disputeId ? { ...d, status: "dismissed", resolved_at: resolvedAt, admin_notes: adminNotes } : d));
    refreshNavCounts();
    toast(t("admin.disputeDismissed"), "info");
  };

  const sidebarContent = (
    <>
      <div style={{ padding: "0 20px 28px", display: "flex", alignItems: "flex-start", justifyContent: "space-between" }}>
        <div>
          <div style={{ fontWeight: 900, fontSize: FS.h3, color: BRAND.primary }}>{SITE.name}</div>
          <div style={{ fontSize: FS.meta, color: ADMIN_SIDEBAR_DIM, fontWeight: 500 }}>Admin Dashboard</div>
        </div>
        {compact && (
          <button onClick={() => setSidebarOpen(false)} aria-label="Close admin menu" style={{ border: "none", background: "transparent", cursor: "pointer", fontSize: FS.h3, color: ADMIN_SIDEBAR_MUTED, lineHeight: 1, padding: 4 }}><Icons.Close size={18} /></button>
        )}
      </div>
      {navItems.map(n => {
        const key = n.id;
        return (
          <button key={n.id} onClick={() => { setView(key); if (compact) setSidebarOpen(false); }} style={{
            display: "block", width: "100%", textAlign: "left", padding: "10px 20px",
            background: view === key ? ADMIN_SIDEBAR_ACTIVE_BG : "none",
            color: view === key ? BRAND.primary : ADMIN_SIDEBAR_MUTED,
            border: "none", cursor: "pointer", fontFamily: "inherit", fontWeight: 600, fontSize: FS.meta,
            borderLeft: view === key ? `3px solid ${BRAND.primary}` : "3px solid transparent",
          }}>
            {n.label}
            {/* Same chip as the employer/worker unread badges. Capped at 99+
                rather than 9+: an operator triaging a queue needs the size. */}
            {navCounts[key] > 0 && (
              <span style={{
                marginLeft: 8, minWidth: 16, height: 16, padding: "0 4px", borderRadius: RADIUS.pill,
                background: BRAND.red, color: ADMIN_SIDEBAR_ON_DARK, fontSize: FS.micro, fontWeight: 700,
                display: "inline-flex", alignItems: "center", justifyContent: "center", lineHeight: 1,
              }}>{navCounts[key] > 99 ? "99+" : navCounts[key]}</span>
            )}
          </button>
        );
      })}
      <div style={{ padding: "24px 20px 0", marginTop: 16, borderTop: `1px solid ${ADMIN_SIDEBAR_RULE}` }}>
        <div style={{ fontSize: FS.meta, color: ADMIN_SIDEBAR_DIM, marginBottom: 8 }}>Logged in as</div>
        {/* Was hardcoded "Rafiq Ismail / Superadmin" -- design-mock filler that
            survived onto a screen only real admins can open, telling the
            operator they were somebody else. There is no "Superadmin" tier
            either: app_metadata.role is 'admin' or it is absent. */}
        <div style={{ fontSize: FS.meta, color: ADMIN_SIDEBAR_TEXT, fontWeight: 600 }}>{adminName}</div>
        <div style={{ fontSize: FS.meta, color: ADMIN_SIDEBAR_DIM, overflowWrap: "anywhere" }}>{adminEmail}</div>
        <Btn size="xs" variant="ghost" onClick={() => onOpenPortal?.("worker")} style={{ marginTop: 10, width: "100%", justifyContent: "center", borderColor: ADMIN_SIDEBAR_RULE, color: ADMIN_SIDEBAR_ON_DARK }}>Return to Worker App</Btn>
      </div>
    </>
  );

  return (
    <div style={{ display: "flex", flexDirection: compact ? "column" : "row", height: "100%" }}>
      {confirmDialog}
      {compact ? (
        <>
          {/* Mobile: a top bar naming the current section, with the nav behind a
              hamburger. Eight stacked full-width buttons otherwise pushed every
              actual metric below the fold. */}
          <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 16px", background: BRAND.dark, flexShrink: 0 }}>
            <button onClick={() => setSidebarOpen(true)} aria-label="Open admin menu" style={{ border: "none", background: "transparent", cursor: "pointer", fontSize: FS.h3, color: ADMIN_SIDEBAR_ON_DARK, padding: 4, lineHeight: 1, display: "inline-flex" }}><Icons.Menu size={20} /></button>
            <div style={{ fontWeight: 800, fontSize: FS.bodyLg, color: ADMIN_SIDEBAR_ON_DARK }}>{navItems.find(n => n.id === view)?.label || "Admin"}</div>
          </div>
          {sidebarOpen && createPortal(
            <div style={{ position: "fixed", inset: 0, zIndex: Z.drawer, display: "flex" }}>
              <div onClick={() => setSidebarOpen(false)} style={{ position: "absolute", inset: 0, background: BRAND.overlay }} />
              <div {...sidebarDialog} style={{ position: "relative", width: "78%", maxWidth: 280, height: "100%", background: BRAND.dark, boxShadow: `4px 0 24px ${BRAND.shadow}`, display: "flex", flexDirection: "column", padding: "24px 0", overflowY: "auto" }}>
                {sidebarContent}
              </div>
            </div>,
            document.body
          )}
        </>
      ) : (
        <div style={{ width: 190, borderRight: `1px solid ${BRAND.border}`, padding: "24px 0", background: BRAND.dark, flexShrink: 0, display: "flex", flexDirection: "column" }}>
          {sidebarContent}
        </div>
      )}

      {/* Content */}
      <div style={{ flex: 1, overflowY: "auto", padding: compact ? 16 : 28, background: BRAND.grayLight }}>

        {view === "overview" && (
          <div>
            <div style={{ ...(compact ? TYPE.titleMobile : TYPE.title), color: BRAND.text, marginBottom: 4 }}>{t("admin.overviewTitle")}</div>
            <div style={{ fontSize: FS.body, color: BRAND.textMuted, marginBottom: 24 }}>Klang Valley — Live metrics</div>
            {/* Row 1: what is waiting on an admin, counted exactly like the
                sidebar chips (refreshNavCounts) so the two never disagree.
                Row 2: how the platform is doing. */}
            <div style={{ display: "grid", gridTemplateColumns: compact ? "1fr 1fr" : "repeat(4, 1fr)", gap: 12, marginBottom: 12 }}>
              <Stat label="Pending KYC" value={navCounts.kycqueue ?? "—"} color={BRAND.amber} />
              <Stat label="Open disputes" value={navCounts.disputes ?? "—"} color={BRAND.red} />
              <Stat label={t("admin.statNewReports")} value={navCounts.reports ?? "—"} color={issueReportsQueue?.some(r => r.status === "new" && r.severity === "blocking") ? BRAND.red : BRAND.amber} />
              <Stat label={t("admin.statPayoutsToRelease")} value={navCounts.payouts ?? "—"} color={BRAND.greenOnSurface} />
            </div>
            <div style={{ display: "grid", gridTemplateColumns: compact ? "1fr 1fr" : "repeat(auto-fit, minmax(160px, 1fr))", gap: 12, marginBottom: 24 }}>
              <Stat label="Open shifts" value={overviewStats?.openShifts ?? "—"} color={BRAND.blue} />
              <Stat label="Fill rate" value={overviewStats?.fillRatePct != null ? `${overviewStats.fillRatePct}%` : "—"} color={BRAND.green} />
              <Stat label="Shifts today" value={overviewStats?.shiftsToday ?? "—"} color={BRAND.primaryOnSurface} />
              <Stat label="Registered workers" value={overviewStats?.activeWorkers ?? "—"} color={BRAND.primaryOnSurface} />
              <Stat label="Registered employers" value={overviewStats?.registeredEmployers ?? "—"} color={BRAND.primaryOnSurface} />
            </div>
            <div style={{ display: "grid", gridTemplateColumns: compact ? "1fr 1fr" : "1fr 1fr 1fr 1fr", gap: 16 }}>
              <Card>
                <div style={{ fontWeight: 700, fontSize: FS.body, color: BRAND.text, marginBottom: 12 }}>KYC Queue</div>
                {kycQueue === null && <div style={{ fontSize: FS.meta, color: BRAND.textMuted }}>Loading…</div>}
                {kycQueue?.length === 0 && <div style={{ fontSize: FS.meta, color: BRAND.textMuted }}>No pending submissions.</div>}
                {kycQueue?.slice(0, 3).map(k => (
                  <div key={k.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 0", borderBottom: `1px solid ${BRAND.border}` }}>
                    <div style={{ fontSize: FS.meta, color: BRAND.text }}>{k.full_name || "Unnamed user"}</div>
                    <Badge color="amber" size="xs">pending</Badge>
                  </div>
                ))}
                <Btn size="xs" variant="secondary" onClick={() => setView("kycqueue")} style={{ marginTop: 10 }}>View all →</Btn>
              </Card>
              <Card>
                <div style={{ fontWeight: 700, fontSize: FS.body, color: BRAND.text, marginBottom: 12 }}>Employer Queue</div>
                {employerQueue === null && <div style={{ fontSize: FS.meta, color: BRAND.textMuted }}>Loading…</div>}
                {employerQueue?.length === 0 && <div style={{ fontSize: FS.meta, color: BRAND.textMuted }}>No pending submissions.</div>}
                {employerQueue?.slice(0, 3).map(e => (
                  <div key={e.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 0", borderBottom: `1px solid ${BRAND.border}` }}>
                    <div style={{ fontSize: FS.meta, color: BRAND.text }}>{e.full_name || "Unnamed employer"}</div>
                    <Badge color="amber" size="xs">pending</Badge>
                  </div>
                ))}
                <Btn size="xs" variant="secondary" onClick={() => setView("employerqueue")} style={{ marginTop: 10 }}>View all →</Btn>
              </Card>
              <Card>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
                  <div style={{ fontWeight: 700, fontSize: FS.body, color: BRAND.text }}>Active Disputes</div>
                </div>
                {disputesQueue === null && <div style={{ fontSize: FS.meta, color: BRAND.textMuted }}>Loading…</div>}
                {disputesQueue?.length === 0 && <div style={{ fontSize: FS.meta, color: BRAND.textMuted }}>{t("admin.disputesEmptyState")}</div>}
                {disputesQueue?.length > 0 && !disputesQueue.some(isOpenDispute) && <div style={{ fontSize: FS.meta, color: BRAND.textMuted }}>{t("admin.disputesNoneOpen")}</div>}
                {/* "Active" means open: a resolved dispute in this card read as
                    one still waiting on someone. */}
                {disputesQueue?.filter(isOpenDispute).slice(0, 3).map(d => (
                  <div key={d.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 0", borderBottom: `1px solid ${BRAND.border}` }}>
                    <div style={{ fontSize: FS.meta, color: BRAND.text }}>{displayProtectedText(d.application?.shift?.title ?? "Shift")} – {t(DISPUTE_CATEGORIES.find(c => c.value === d.category)?.labelKey ?? "dispute.categoryOther")}</div>
                    <Badge color={d.status === "under_review" ? "amber" : d.status === "resolved" ? "green" : d.status === "dismissed" ? "gray" : "blue"} size="xs">{disputeStatusLabel(d.status, t)}</Badge>
                  </div>
                ))}
                <Btn size="xs" variant="secondary" onClick={() => setView("disputes")} style={{ marginTop: 10 }}>View all →</Btn>
              </Card>
              <Card>
                <div style={{ fontWeight: 700, fontSize: FS.body, color: BRAND.text, marginBottom: 12 }}>Analytics (7d)</div>
                {analyticsCounts === null && <div style={{ fontSize: FS.meta, color: BRAND.textMuted }}>Loading…</div>}
                {analyticsCounts?.length === 0 && <div style={{ fontSize: FS.meta, color: BRAND.textMuted }}>No events recorded.</div>}
                {analyticsCounts?.map(({ eventType, count }) => (
                  <div key={eventType} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 0", borderBottom: `1px solid ${BRAND.border}` }}>
                    <div style={{ fontSize: FS.meta, color: BRAND.text }}>{eventType}</div>
                    <div style={{ fontSize: FS.meta, color: BRAND.textMuted, fontWeight: 600 }}>{count}</div>
                  </div>
                ))}
              </Card>
            </div>
          </div>
        )}

        {view === "kycqueue" && (
          <div>
            <div style={{ ...(compact ? TYPE.titleMobile : TYPE.title), color: BRAND.text, marginBottom: 4 }}>{t("admin.kycQueueTitle")}</div>
            <div style={{ fontSize: FS.body, color: BRAND.textMuted, marginBottom: 24 }}>
              {kycQueue === null ? "Loading…" : `${kycQueue.length} pending review${kycQueue.length !== 1 ? "s" : ""}`}
            </div>

            {kycQueue === null && (
              <div style={{ color: BRAND.textMuted, padding: 16 }}>Loading...</div>
            )}
            {kycQueue?.length === 0 && (
              <div style={{ color: BRAND.textMuted, padding: 16 }}><InlineIcon icon={Icons.Check} size={14} />No pending KYC submissions.</div>
            )}

            {kycQueue?.map(worker => (
              <Card key={worker.id} style={{ marginBottom: 14 }}>
                {/* Header row */}
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 10 }}>
                  <div>
                    <div style={{ fontWeight: 700, fontSize: FS.bodyLg, color: BRAND.text }}>{worker.full_name || "Unnamed user"}</div>
                    <div style={{ fontSize: FS.meta, color: BRAND.textMuted, marginTop: 2 }}>
                      {/* There is no "documents submitted at" column; created_at is
                          when the account was made, so say that rather than
                          passing it off as the submission time. */}
                      Joined: {new Date(worker.created_at).toLocaleDateString("en-MY", { day: "numeric", month: "short", year: "numeric" })}
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "flex-end" }}>
                    <Btn size="sm" variant="secondary" onClick={() => loadKycDocuments(worker.id)}>
                      View Docs
                    </Btn>
                    <Btn size="sm" variant="success" onClick={() => approveKyc(worker, "Standard")}>
                      Approve Standard
                    </Btn>
                    <Btn size="sm" variant="success" onClick={() => approveKyc(worker, "Advanced")}>
                      Approve Advanced
                    </Btn>
                    <Btn size="sm" variant="danger" onClick={() => rejectKyc(worker)}>
                      Reject
                    </Btn>
                  </div>
                </div>

                {/* Documents */}
                {kycSignedUrls[worker.id] && (
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
                    {Object.keys(kycSignedUrls[worker.id]).length === 0 ? (
                      <div style={{ fontSize: FS.meta, color: BRAND.textMuted }}>No documents found in storage.</div>
                    ) : (
                      Object.entries(kycSignedUrls[worker.id]).map(([filename, url]) => (
                        <a key={filename} href={url} target="_blank" rel="noopener noreferrer"
                          style={{ fontSize: FS.meta, color: BRAND.primaryOnSurface, textDecoration: "underline" }}>
                          <InlineIcon icon={Icons.Doc} />{filename}
                        </a>
                      ))
                    )}
                  </div>
                )}
              </Card>
            ))}
          </div>
        )}

        {view === "employerqueue" && (
          <div>
            <div style={{ ...(compact ? TYPE.titleMobile : TYPE.title), color: BRAND.text, marginBottom: 4 }}>{t("admin.employerQueueTitle")}</div>
            <div style={{ fontSize: FS.body, color: BRAND.textMuted, marginBottom: 24 }}>
              {employerQueue === null ? "Loading…" : `${employerQueue.length} pending verification${employerQueue.length !== 1 ? "s" : ""}`}
            </div>
            {employerQueue === null && (
              <div style={{ color: BRAND.textMuted, padding: 16 }}>Loading...</div>
            )}
            {employerQueue?.length === 0 && (
              <div style={{ color: BRAND.textMuted, padding: 16 }}><InlineIcon icon={Icons.Check} size={14} />No employers awaiting verification.</div>
            )}
            {employerQueue?.map(emp => (
              <Card key={emp.id} style={{ marginBottom: 14 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, flexWrap: "wrap" }}>
                  <div>
                    <div style={{ fontWeight: 700, fontSize: FS.bodyLg, color: BRAND.text }}>{emp.full_name || "Unnamed company"}</div>
                    <div style={{ fontSize: FS.meta, color: BRAND.text, marginTop: 4 }}>SSM: <strong>{emp.ssm_number || "—"}</strong></div>
                    <div style={{ fontSize: FS.meta, color: BRAND.textMuted, marginTop: 2 }}>
                      Registered: {new Date(emp.created_at).toLocaleDateString("en-MY", { day: "numeric", month: "short", year: "numeric" })}
                    </div>
                    <div style={{ fontSize: FS.meta, color: BRAND.textMuted, marginTop: 6, lineHeight: 1.5 }}>
                      Check the SSM number against the official registry (ssm-einfo.my) before verifying — the number alone proves nothing.
                      {emp.ssm_document_path ? " Compare it with the uploaded certificate." : " No certificate uploaded."}
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "flex-end" }}>
                    {emp.ssm_document_path && (
                      <Btn size="sm" variant="secondary" onClick={async () => {
                        const { data, error } = await supabase.storage.from(KYC_BUCKET).createSignedUrl(emp.ssm_document_path, 300);
                        if (error || !data?.signedUrl) { toast(`Could not open certificate: ${error?.message || "no URL"}`, "error"); return; }
                        window.open(data.signedUrl, "_blank", "noopener");
                      }}>
                        View certificate
                      </Btn>
                    )}
                    <Btn size="sm" variant="success" onClick={() => setEmployerVerification(emp, "verified")}>
                      Verify
                    </Btn>
                    <Btn size="sm" variant="danger" onClick={() => setEmployerVerification(emp, "rejected")}>
                      Reject
                    </Btn>
                  </div>
                </div>
              </Card>
            ))}
          </div>
        )}

        {view === "disputes" && (
          <div>
            <div style={{ ...(compact ? TYPE.titleMobile : TYPE.title), color: BRAND.text, marginBottom: 4 }}>{t("admin.disputesTitle")}</div>
            <div style={{ fontSize: FS.body, color: BRAND.textMuted, marginBottom: 24 }}>
              {disputesQueue === null ? "Loading…" : `${disputesQueue.length} dispute${disputesQueue.length !== 1 ? "s" : ""} total`}
            </div>
            {disputesQueue?.length === 0 && (
              <div style={{ color: BRAND.textMuted, padding: 16 }}>{t("admin.disputesEmptyState")}</div>
            )}
            {disputesQueue?.length > 0 && !disputesQueue.some(isOpenDispute) && (
              <div style={{ color: BRAND.textMuted, padding: "0 0 16px" }}>{t("admin.disputesNoneOpen")}</div>
            )}
            {/* Open first; filter keeps the newest-first order within each half. */}
            {disputesQueue && [
              ...disputesQueue.filter(isOpenDispute),
              ...(showClosedDisputes ? disputesQueue.filter(d => !isOpenDispute(d)) : []),
            ].map(d => {
              const categoryLabel = t(DISPUTE_CATEGORIES.find(c => c.value === d.category)?.labelKey ?? "dispute.categoryOther");
              const isPending = d.status === "open" || d.status === "under_review";
              return (
                <Card key={d.id} style={{ marginBottom: 14 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12 }}>
                    <div>
                      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 4 }}>
                        <span style={{ fontWeight: 800, fontSize: FS.body, color: BRAND.text }}>{categoryLabel}</span>
                        <Badge color={d.status === "under_review" ? "amber" : d.status === "resolved" ? "green" : d.status === "dismissed" ? "gray" : "blue"}>{disputeStatusLabel(d.status, t)}</Badge>
                      </div>
                      <div style={{ fontSize: FS.meta, color: BRAND.textMuted }}>Opened {new Date(d.created_at).toLocaleDateString("en-MY")}</div>
                    </div>
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 12 }}>
                    <div><div style={{ fontSize: FS.meta, color: BRAND.textMuted }}>Shift</div><div style={{ fontSize: FS.meta, fontWeight: 600, color: BRAND.text }}>{displayProtectedText(d.application?.shift?.title ?? "—")}</div></div>
                    <div><div style={{ fontSize: FS.meta, color: BRAND.textMuted }}>Worker</div><div style={{ fontSize: FS.meta, fontWeight: 600, color: BRAND.text }}>{d.application?.worker?.full_name || "—"}</div></div>
                    <div><div style={{ fontSize: FS.meta, color: BRAND.textMuted }}>Employer</div><div style={{ fontSize: FS.meta, fontWeight: 600, color: BRAND.text }}>{d.application?.shift?.employer?.full_name || "—"}</div></div>
                  </div>
                  <div style={{ fontSize: FS.meta, color: BRAND.text, lineHeight: 1.6, marginBottom: 12, whiteSpace: "pre-wrap" }}>{d.description}</div>
                  {d.admin_notes && (
                    <div style={{ fontSize: FS.meta, color: BRAND.textMuted, marginBottom: 12, padding: "8px 12px", background: BRAND.grayLight, borderRadius: RADIUS.control }}>
                      Admin notes: {d.admin_notes}
                    </div>
                  )}
                  {isPending ? (
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                      <Btn size="sm" variant="secondary" onClick={() => setDisputeDetailFor(d)}>{t("admin.disputeInvestigate")}</Btn>
                      {d.status === "open" && (
                        <Btn size="sm" variant="secondary" onClick={() => markDisputeUnderReview(d.id)}>{t("admin.disputeMarkUnderReview")}</Btn>
                      )}
                      <Btn size="sm" variant="success" onClick={() => resolveDispute(d)}>{t("admin.disputeResolve")}</Btn>
                      <Btn size="sm" variant="secondary" onClick={() => dismissDispute(d)}>{t("admin.disputeDismiss")}</Btn>
                    </div>
                  ) : (
                    <div style={{ padding: "8px 12px", borderRadius: RADIUS.control, background: d.status === "resolved" ? BRAND.greenLight : BRAND.grayLight, fontSize: FS.meta, fontWeight: 600, color: d.status === "resolved" ? "#065F46" : BRAND.textMuted }}>
                      {d.status === "resolved" ? <><InlineIcon icon={Icons.Check} />{t("admin.disputeResolve")}</> : <><InlineIcon icon={Icons.Close} />{t("admin.disputeDismiss")}</>}
                      {d.resolved_at ? ` — ${new Date(d.resolved_at).toLocaleDateString("en-MY")}` : ""}
                    </div>
                  )}
                </Card>
              );
            })}
            {disputesQueue?.some(d => !isOpenDispute(d)) && (
              <Btn variant="secondary" aria-expanded={showClosedDisputes} onClick={() => setShowClosedDisputes(v => !v)} style={{ width: "100%", minHeight: 44 }}>
                {showClosedDisputes
                  ? t("admin.hideClosed")
                  : t("admin.showClosed", { n: disputesQueue.filter(d => !isOpenDispute(d)).length })}
              </Btn>
            )}
          </div>
        )}

        {disputeDetailFor && createPortal(
          <div style={{ position: "fixed", inset: 0, background: BRAND.overlay, zIndex: Z.modal, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }} onClick={() => setDisputeDetailFor(null)}>
            <div {...disputeDetailDialog} onClick={e => e.stopPropagation()} style={{ background: BRAND.surface, borderRadius: RADIUS.card, padding: 24, maxWidth: 560, width: "100%", maxHeight: "85vh", overflowY: "auto", border: `1px solid ${BRAND.border}` }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 16 }}>
                <h3 style={{ fontSize: FS.lead, fontWeight: 700, color: BRAND.text, margin: 0 }}>{t("admin.disputeInvestigateTitle")}</h3>
                <button onClick={() => setDisputeDetailFor(null)} aria-label={t("common.close")} style={{ border: "none", background: "transparent", cursor: "pointer", fontSize: FS.h3, color: BRAND.textMuted, lineHeight: 1 }}><Icons.Close size={18} /></button>
              </div>

              {/* Evidence -- read-only, no mutation. Same data every worker/
                  employer contract screen already shows, just surfaced here
                  so admin does not have to trust the free-text description
                  alone. */}
              <div style={{ fontSize: FS.meta, fontWeight: 700, color: BRAND.textMuted, marginBottom: 8 }}>{t("admin.disputeEvidenceTitle")}</div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 20 }}>
                {[
                  [t("admin.disputeShiftWindow"), disputeDetailFor.application?.shift?.start_at ? `${new Date(disputeDetailFor.application.shift.start_at).toLocaleString("en-MY")} – ${disputeDetailFor.application.shift.end_at ? new Date(disputeDetailFor.application.shift.end_at).toLocaleString("en-MY") : "—"}` : t("admin.disputeNotRecorded")],
                  [t("admin.disputeWageRange"), disputeDetailFor.application?.shift ? `${toCurrency(disputeDetailFor.application.shift.wage_min)} – ${toCurrency(disputeDetailFor.application.shift.wage_max)}` : t("admin.disputeNotRecorded")],
                  [t("admin.disputeWageAsk"), disputeDetailFor.application?.wage_ask != null ? toCurrency(disputeDetailFor.application.wage_ask) : t("admin.disputeNotRecorded")],
                  [t("admin.disputeCheckedIn"), disputeDetailFor.application?.checked_in_at ? new Date(disputeDetailFor.application.checked_in_at).toLocaleString("en-MY") : t("admin.disputeNotRecorded")],
                  [t("admin.disputeCheckedOut"), disputeDetailFor.application?.checked_out_at ? new Date(disputeDetailFor.application.checked_out_at).toLocaleString("en-MY") : t("admin.disputeNotRecorded")],
                  [t("admin.disputeCheckedInBy"), disputeDetailFor.application?.checked_in_method ? t(`admin.method.${disputeDetailFor.application.checked_in_method}`) : t("admin.disputeNotRecorded")],
                  [t("admin.disputeCheckedOutBy"), disputeDetailFor.application?.checked_out_method ? t(`admin.method.${disputeDetailFor.application.checked_out_method}`) : t("admin.disputeNotRecorded")],
                  [t("admin.disputeReportedHours"), disputeDetailFor.application?.worker_reported_hours != null ? `${disputeDetailFor.application.worker_reported_hours}h${disputeDetailFor.application.employer_hours_confirmed_at ? ` · ${t("employer.confirmedStatus")}` : ""}` : t("admin.disputeNotRecorded")],
                  [t("admin.disputeNoShow"), disputeDetailFor.application?.no_show_at ? `${new Date(disputeDetailFor.application.no_show_at).toLocaleString("en-MY")}${disputeDetailFor.application.no_show_note ? ` — ${disputeDetailFor.application.no_show_note}` : ""}` : "—"],
                  [t("admin.disputeWorkerSigned"), disputeDetailFor.application?.worker_signed_at ? new Date(disputeDetailFor.application.worker_signed_at).toLocaleString("en-MY") : t("admin.disputeNotRecorded")],
                  [t("admin.disputeEmployerSigned"), disputeDetailFor.application?.employer_signed_at ? new Date(disputeDetailFor.application.employer_signed_at).toLocaleString("en-MY") : t("admin.disputeNotRecorded")],
                ].map(([label, value]) => (
                  <div key={label}>
                    <div style={{ fontSize: FS.meta, color: BRAND.textMuted }}>{label}</div>
                    <div style={{ fontSize: FS.meta, fontWeight: 600, color: BRAND.text }}>{value}</div>
                  </div>
                ))}
              </div>

              {/* Attendance ruling -- the only thing on this panel that changes
                  the underlying record (check-in/out, hours, no-show mark, and
                  through them the payout). Closes the dispute. */}
              {(disputeDetailFor.status === "open" || disputeDetailFor.status === "under_review") && (
                <div style={{ border: `1px solid ${BRAND.border}`, borderRadius: RADIUS.card, padding: 14, marginBottom: 20 }}>
                  <div style={{ fontSize: FS.meta, fontWeight: 700, color: BRAND.textMuted, marginBottom: 4 }}>{t("admin.rulingTitle")}</div>
                  <div style={{ fontSize: FS.meta, color: BRAND.textMuted, marginBottom: 10 }}>{t("admin.rulingHint")}</div>
                  <Select
                    label={t("admin.rulingOutcomeLabel")}
                    value={rulingOutcome}
                    onChange={e => setRulingOutcome(e.target.value)}
                    options={[
                      { value: "grant_attendance", label: t("admin.rulingGrant") },
                      { value: "confirm_no_show", label: t("admin.rulingConfirmNoShow") },
                      { value: "reverse_no_show", label: t("admin.rulingReverseNoShow") },
                    ]}
                  />
                  {rulingOutcome === "grant_attendance" && (
                    <input type="number" step="0.25" min="0" value={rulingHours} onChange={e => setRulingHours(e.target.value)} placeholder={t("admin.rulingHoursLabel")}
                      style={{ width: "100%", boxSizing: "border-box", padding: "10px 14px", borderRadius: RADIUS.control, border: `1.5px solid ${BRAND.border}`, fontSize: FS.body, fontFamily: "inherit", color: BRAND.text, background: BRAND.input, marginBottom: 10 }} />
                  )}
                  <textarea value={rulingNote} onChange={e => setRulingNote(e.target.value)} placeholder={t("admin.rulingNoteLabel")} rows={2}
                    style={{ width: "100%", boxSizing: "border-box", padding: "10px 14px", borderRadius: RADIUS.control, border: `1.5px solid ${BRAND.border}`, fontSize: FS.meta, fontFamily: "inherit", color: BRAND.text, background: BRAND.input, resize: "vertical", marginBottom: 10 }} />
                  <Btn size="sm" onClick={applyAttendanceRuling} disabled={applyingRuling || (rulingOutcome === "grant_attendance" && (!rulingHours || Number(rulingHours) <= 0))}>{t("admin.rulingApplyBtn")}</Btn>
                </div>
              )}

              {/* Discuss -- the SAME group chat room worker+employer already
                  share for this shift (messages, recipient_id null). Admin
                  posting here is visible to both parties inline with the job
                  chat, not a separate admin-only thread. */}
              <div style={{ fontSize: FS.meta, fontWeight: 700, color: BRAND.textMuted, marginBottom: 8 }}>{t("admin.disputeChatTitle")}</div>
              <div style={{ border: `1px solid ${BRAND.border}`, borderRadius: RADIUS.card, maxHeight: 220, overflowY: "auto", padding: 12, marginBottom: 12 }}>
                {disputeMessages === null && <div style={{ fontSize: FS.meta, color: BRAND.textMuted }}>Loading…</div>}
                {disputeMessages?.length === 0 && <div style={{ fontSize: FS.meta, color: BRAND.textMuted }}>{t("admin.disputeChatEmpty")}</div>}
                {disputeMessages?.map(m => (
                  <div key={m.id} style={{ marginBottom: 10 }}>
                    <div style={{ fontSize: FS.meta, color: BRAND.textMuted, marginBottom: 2 }}>
                      {disputeSenderNames[m.sender_id] ?? "…"} · {new Date(m.created_at).toLocaleString("en-MY")}
                    </div>
                    <div style={{ fontSize: FS.meta, color: BRAND.text, whiteSpace: "pre-wrap" }}>{m.content}</div>
                  </div>
                ))}
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <input
                  value={disputeMessageInput}
                  onChange={e => setDisputeMessageInput(e.target.value)}
                  onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendDisputeMessage(); } }}
                  placeholder={t("chat.inputPlaceholder")}
                  style={{ flex: 1, padding: "10px 14px", borderRadius: RADIUS.control, border: `1.5px solid ${BRAND.border}`, fontSize: FS.body, fontFamily: "inherit", color: BRAND.text, background: BRAND.input, outline: "none" }}
                />
                <Btn size="sm" onClick={sendDisputeMessage} disabled={sendingDisputeMessage || !disputeMessageInput.trim()}>{t("chat.send")}</Btn>
              </div>
            </div>
          </div>,
          document.body
        )}

        {view === "reports" && (
          <div>
            <div style={{ ...(compact ? TYPE.titleMobile : TYPE.title), color: BRAND.text, marginBottom: 4 }}>{t("admin.reportsTitle")}</div>
            <div style={{ fontSize: FS.body, color: BRAND.textMuted, marginBottom: 24 }}>
              {issueReportsQueue === null ? "Loading…" : t("admin.reportsCount").replace("{n}", issueReportsQueue.length).replace("{s}", issueReportsQueue.length === 1 ? "" : "s")}
            </div>
            {issueReportsQueue?.length === 0 && (
              <div style={{ color: BRAND.textMuted, padding: 16 }}>{t("admin.reportsEmpty")}</div>
            )}
            {issueReportsQueue?.length > 0 && !issueReportsQueue.some(isOpenReport) && (
              <div style={{ color: BRAND.textMuted, padding: "0 0 16px" }}>{t("admin.reportsNoneOpen")}</div>
            )}
            {/* Open first; Array.prototype.filter keeps the newest-first order
                within each half. */}
            {issueReportsQueue && [
              ...issueReportsQueue.filter(isOpenReport),
              ...(showClosedReports ? issueReportsQueue.filter(r => !isOpenReport(r)) : []),
            ].map(r => (
              <Card key={r.id} style={{ marginBottom: 14 }}>
                <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 10 }}>
                  <Badge color={r.severity === "blocking" ? "red" : r.severity === "normal" ? "amber" : "gray"}>{t(`issue.sev.${r.severity}`)}</Badge>
                  <Badge color="gray">{t(`issue.cat.${r.category}`)}</Badge>
                  <span style={{ fontSize: FS.meta, color: BRAND.textMuted, marginLeft: "auto" }}>{new Date(r.created_at).toLocaleString("en-MY")}</span>
                </div>
                <div style={{ fontSize: FS.meta, color: BRAND.text, lineHeight: 1.6, whiteSpace: "pre-wrap", marginBottom: 10 }}>{r.description}</div>
                <div style={{ display: "flex", gap: 16, flexWrap: "wrap", fontSize: FS.meta, color: BRAND.textMuted, marginBottom: 12 }}>
                  <span>{t("admin.reportReportedBy")}: {r.reporter_role ?? "—"}</span>
                  {r.page_context && <span>{t("admin.reportPage")}: {r.page_context}</span>}
                </div>
                <Select
                  label=""
                  value={issueStatusDrafts[r.id] ?? r.status}
                  onChange={e => setIssueStatusDrafts(prev => ({ ...prev, [r.id]: e.target.value }))}
                  options={Object.keys(ISSUE_STATUS_LABEL_KEYS).map(s => ({ value: s, label: t(ISSUE_STATUS_LABEL_KEYS[s]) }))}
                  style={{ marginBottom: 10 }}
                />
                <div style={{ fontSize: FS.meta, color: BRAND.textMuted, marginBottom: 4 }}>{t("admin.reportNoteLabel")}</div>
                <textarea
                  value={issueNoteDrafts[r.id] ?? r.admin_note ?? ""}
                  onChange={e => setIssueNoteDrafts(prev => ({ ...prev, [r.id]: e.target.value }))}
                  placeholder={t("admin.reportNotePlaceholder")}
                  rows={2}
                  style={{ width: "100%", padding: "8px 12px", borderRadius: RADIUS.control, border: `1px solid ${BRAND.border}`, fontSize: FS.meta, fontFamily: "inherit", color: BRAND.text, background: BRAND.input, resize: "vertical", marginBottom: 8 }}
                />
                {issueStatusDrafts[r.id] !== undefined && issueStatusDrafts[r.id] !== r.status && (
                  <div style={{ fontSize: FS.meta, color: BRAND.onAmberLight, marginBottom: 6 }}>{t("admin.reportStatusUnsaved")}</div>
                )}
                <Btn size="sm" onClick={() => saveIssueReport(r.id, issueStatusDrafts[r.id] ?? r.status)} disabled={savingIssueReport === r.id}>{t("admin.reportSave")}</Btn>
              </Card>
            ))}
            {issueReportsQueue?.some(r => !isOpenReport(r)) && (
              <Btn variant="secondary" aria-expanded={showClosedReports} onClick={() => setShowClosedReports(v => !v)} style={{ width: "100%", minHeight: 44 }}>
                {showClosedReports
                  ? t("admin.hideClosed")
                  : t("admin.showClosed", { n: issueReportsQueue.filter(r => !isOpenReport(r)).length })}
              </Btn>
            )}
          </div>
        )}

        {view === "flags" && (
          <div>
            <div style={{ ...(compact ? TYPE.titleMobile : TYPE.title), color: BRAND.text, marginBottom: 4 }}>{t("admin.flagsTitle")}</div>
            <div style={{ fontSize: FS.body, color: BRAND.textMuted, marginBottom: 24 }}>{t("admin.flagsCount").replace("{n}", FLAGS.length)}</div>
            <EmptyState
              icon={<Icons.Flag size={28} />}
              title={t("admin.flagsEmptyTitle")}
              hint={t("admin.flagsEmptyHint")}
            />
          </div>
        )}

        {view === "deposits" && (
          <div>
            <div style={{ ...(compact ? TYPE.titleMobile : TYPE.title), color: BRAND.text, marginBottom: 6 }}>{t("admin.depositsTitle")}</div>
            <div style={{ fontSize: FS.meta, color: BRAND.textMuted, marginBottom: 20, maxWidth: 640, lineHeight: 1.55 }}>
              {t("admin.depositsIntro")}
            </div>

            {/* Said once, prominently, because it is the thing that cannot be
                undone: the ledger is append-only by design. */}
            <div style={{ background: BRAND.amberLight, borderRadius: RADIUS.control, padding: "10px 14px", marginBottom: 20, fontSize: FS.meta, color: BRAND.onAmberLight, lineHeight: 1.5, maxWidth: 640 }}>
              {t("admin.depositsAppendOnlyWarning")}
            </div>

            <Card style={{ marginBottom: 20, maxWidth: 640 }}>
              <div style={{ fontSize: FS.meta, fontWeight: 700, color: BRAND.textMuted, marginBottom: 10 }}>{t("admin.depositEmployerLabel")}</div>
              {depositEmployers === null ? (
                <div style={{ fontSize: FS.meta, color: BRAND.textMuted }}>{t("admin.depositLoading")}</div>
              ) : depositEmployers.length === 0 ? (
                <div style={{ fontSize: FS.meta, color: BRAND.textMuted }}>{t("admin.depositNoEmployers")}</div>
              ) : (
                <>
                  <input
                    value={depositSearch}
                    onChange={(e) => setDepositSearch(e.target.value)}
                    placeholder={t("admin.depositSearchPlaceholder")}
                    style={{ width: "100%", padding: "8px 10px", borderRadius: RADIUS.control, border: `1px solid ${BRAND.border}`, background: BRAND.input, color: BRAND.text, fontSize: FS.meta, boxSizing: "border-box", marginBottom: 10, fontFamily: "inherit" }}
                  />
                  <div style={{ maxHeight: 180, overflowY: "auto", border: `1px solid ${BRAND.border}`, borderRadius: RADIUS.control }}>
                    {depositEmployers
                      .filter(e => !depositSearch.trim() || (e.full_name || "").toLowerCase().includes(depositSearch.trim().toLowerCase()))
                      .map(e => (
                        <button
                          key={e.id}
                          onClick={() => { setDepositTarget(e); setDepositResult(null); }}
                          style={{
                            width: "100%", textAlign: "left", padding: "9px 12px", border: "none",
                            borderBottom: `1px solid ${BRAND.border}`, cursor: "pointer", fontFamily: "inherit",
                            background: depositTarget?.id === e.id ? BRAND.primaryLight : "transparent",
                            color: depositTarget?.id === e.id ? BRAND.onPrimaryLight : BRAND.text,
                            fontSize: FS.meta, fontWeight: depositTarget?.id === e.id ? 700 : 500,
                          }}
                        >
                          {e.full_name || t("admin.depositUnnamed")}
                          {e.employer_verification_status !== "verified" && (
                            <span style={{ fontSize: FS.meta, color: BRAND.textMuted, marginLeft: 8 }}>
                              {t("admin.depositUnverifiedNote")}
                            </span>
                          )}
                        </button>
                      ))}
                  </div>
                </>
              )}
            </Card>

            {depositTarget && (
              <Card style={{ marginBottom: 20, maxWidth: 640 }}>
                <div style={{ fontSize: FS.meta, fontWeight: 700, color: BRAND.text, marginBottom: 12 }}>
                  {t("admin.depositFormTitle", { name: depositTarget.full_name || t("admin.depositUnnamed") })}
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 }}>
                  <div>
                    <div style={{ fontSize: FS.meta, color: BRAND.textMuted, marginBottom: 4 }}>{t("admin.depositAmountLabel")}</div>
                    <input
                      type="number" min="0" step="0.01" inputMode="decimal"
                      value={depositAmount}
                      onChange={(e) => setDepositAmount(e.target.value)}
                      placeholder="0.00"
                      style={{ width: "100%", padding: "8px 10px", borderRadius: RADIUS.control, border: `1px solid ${BRAND.border}`, background: BRAND.input, color: BRAND.text, fontSize: FS.meta, boxSizing: "border-box", fontFamily: "inherit" }}
                    />
                  </div>
                  <div>
                    <div style={{ fontSize: FS.meta, color: BRAND.textMuted, marginBottom: 4 }}>{t("admin.depositReferenceLabel")}</div>
                    <input
                      value={depositReference}
                      onChange={(e) => setDepositReference(e.target.value)}
                      placeholder={t("admin.depositReferencePlaceholder")}
                      style={{ width: "100%", padding: "8px 10px", borderRadius: RADIUS.control, border: `1px solid ${BRAND.border}`, background: BRAND.input, color: BRAND.text, fontSize: FS.meta, boxSizing: "border-box", fontFamily: "inherit" }}
                    />
                  </div>
                </div>
                <div style={{ fontSize: FS.meta, color: BRAND.textMuted, lineHeight: 1.5, marginBottom: 12 }}>
                  {t("admin.depositReferenceHint")}
                </div>
                {!depositConfirming ? (
                  <Btn
                    onClick={() => setDepositConfirming(true)}
                    disabled={!depositAmount || !depositReference.trim()}
                  >
                    {t("admin.depositReviewBtn")}
                  </Btn>
                ) : (
                  <div style={{ border: `1px solid ${BRAND.amber}`, borderRadius: RADIUS.control, padding: "12px 14px" }}>
                    <div style={{ fontSize: FS.meta, color: BRAND.text, lineHeight: 1.6, marginBottom: 12 }}>
                      {t("admin.depositConfirmBody", {
                        amount: Number(depositAmount || 0).toFixed(2),
                        name: depositTarget.full_name || t("admin.depositUnnamed"),
                        reference: depositReference.trim(),
                      })}
                    </div>
                    <div style={{ display: "flex", gap: 10 }}>
                      <Btn onClick={submitDeposit} disabled={depositSubmitting}>
                        {depositSubmitting ? t("admin.depositRecording") : t("admin.depositConfirmBtn")}
                      </Btn>
                      <Btn variant="secondary" onClick={() => setDepositConfirming(false)} disabled={depositSubmitting}>
                        {t("admin.depositCancelBtn")}
                      </Btn>
                    </div>
                  </div>
                )}
              </Card>
            )}

            {depositResult && (
              <Card style={{ marginBottom: 20, maxWidth: 640, borderLeft: `3px solid ${BRAND.green}` }}>
                <div style={{ fontSize: FS.meta, fontWeight: 700, color: BRAND.text, marginBottom: 8 }}>{t("admin.depositDoneTitle")}</div>
                <div style={{ fontSize: FS.meta, color: BRAND.textMuted, lineHeight: 1.6 }}>
                  {t("admin.depositDoneBody", {
                    amount: Number(depositResult.amount ?? 0).toFixed(2),
                    name: depositResult.employer_name || "",
                    available: Number(depositResult.available ?? 0).toFixed(2),
                    held: Number(depositResult.held ?? 0).toFixed(2),
                  })}
                </div>
              </Card>
            )}

            <div style={{ fontSize: FS.meta, fontWeight: 700, color: BRAND.text, marginBottom: 10 }}>{t("admin.depositRecentTitle")}</div>
            <Card style={{ maxWidth: 640 }}>
              {depositRecent === null ? (
                <div style={{ fontSize: FS.meta, color: BRAND.textMuted }}>{t("admin.depositLoading")}</div>
              ) : depositRecent.length === 0 ? (
                <div style={{ fontSize: FS.meta, color: BRAND.textMuted }}>{t("admin.depositRecentEmpty")}</div>
              ) : (
                depositRecent.map(r => {
                  const who = (depositEmployers || []).find(e => e.id === r.employer_id);
                  return (
                    <div key={r.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12, padding: "8px 0", borderBottom: `1px solid ${BRAND.border}` }}>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontSize: FS.meta, color: BRAND.text, fontWeight: 600 }}>{who?.full_name || r.employer_id?.slice(0, 8) || "—"}</div>
                        <div style={{ fontSize: FS.meta, color: BRAND.textMuted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.note}</div>
                      </div>
                      <div style={{ fontSize: FS.meta, fontWeight: 700, color: BRAND.text, flexShrink: 0 }}>RM{Number(r.amount ?? 0).toFixed(2)}</div>
                    </div>
                  );
                })
              )}
            </Card>
          </div>
        )}

        {view === "payouts" && (
          <div>
            <div style={{ ...(compact ? TYPE.titleMobile : TYPE.title), color: BRAND.text, marginBottom: 24 }}>{t("admin.payoutsTitle")}</div>
            <div style={{ display: "grid", gridTemplateColumns: compact ? "1fr" : "repeat(3, 1fr)", gap: 12, marginBottom: 24 }}>
              <Stat label="Pending payouts" value={toCurrency((livePayoutQueue || []).filter(p => p.status === "ready" || p.status === "scheduled").reduce((sum, item) => sum + Number(item.amount || 0), 0))} color={BRAND.amber} />
              <Stat label="Disputed (held)" value={toCurrency((livePayoutQueue || []).filter(p => p.status === "held").reduce((sum, item) => sum + Number(item.amount || 0), 0))} color={BRAND.red} />
              <Stat label="Processed internal" value={toCurrency((livePayoutQueue || []).filter(p => p.status === "processed_internal").reduce((sum, item) => sum + Number(item.amount || 0), 0))} color={BRAND.green} />
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 10, marginBottom: 12 }}>
              <Btn onClick={runScheduler} disabled={payoutRunning}>{payoutRunning ? "Running..." : "Run Internal Scheduler"}</Btn>
              <Btn variant="secondary" onClick={loadPayoutQueue}>Refresh Queue</Btn>
            </div>
            {payoutMessage && <div style={{ fontSize: FS.meta, color: BRAND.textMuted, marginBottom: 10 }}>{payoutMessage}</div>}
            <Card>
              <div style={{ fontWeight: 700, fontSize: FS.body, color: BRAND.text, marginBottom: 16 }}>Payout Queue</div>
              {/* Six columns will never fit a phone. Scroll the TABLE, not the
                  page -- a body that scrolls sideways drags the whole layout
                  with it. */}
              <div style={{ overflowX: "auto", WebkitOverflowScrolling: "touch" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 620 }}>
                <thead>
                  <tr style={{ background: BRAND.grayLight }}>
                    {["Worker", "Shift", "Amount", "Scheduled", "Status", "Action"].map(h => (
                      <th key={h} style={{ padding: "10px 12px", fontSize: FS.meta, fontWeight: 700, color: BRAND.textMuted, textAlign: "left", borderBottom: `1px solid ${BRAND.border}` }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {livePayoutQueue === null && (
                    <tr>
                      <td colSpan={6} style={{ padding: "20px 12px", textAlign: "center", fontSize: FS.meta, color: BRAND.textMuted }}>Loading payout queue…</td>
                    </tr>
                  )}
                  {livePayoutQueue && livePayoutQueue.length === 0 && (
                    <tr>
                      <td colSpan={6} style={{ padding: "20px 12px", textAlign: "center", fontSize: FS.meta, color: BRAND.textMuted }}>No payouts in the queue. Run the internal scheduler to generate this cycle's payouts.</td>
                    </tr>
                  )}
                  {(livePayoutQueue || []).map((p) => (
                    <tr key={p.id} style={{ borderBottom: `1px solid ${BRAND.border}` }}>
                      <td style={{ padding: "10px 12px", fontSize: FS.meta, fontWeight: 600, color: BRAND.text }}>{(p.worker_id && payoutQueueWorkerNames[p.worker_id]) || "N/A"}</td>
                      <td style={{ padding: "10px 12px", fontSize: FS.meta, color: BRAND.textMuted }}>{(p.source_refs?.shift_id && payoutQueueShiftTitles[p.source_refs.shift_id]) || "Shift"}</td>
                      <td style={{ padding: "10px 12px", fontSize: FS.meta, fontWeight: 700, color: BRAND.greenOnSurface }}>{toCurrency(p.amount)}</td>
                      <td style={{ padding: "10px 12px", fontSize: FS.meta, color: BRAND.textMuted }}>{p.scheduled_date ? new Date(p.scheduled_date).toLocaleDateString("en-MY") : "TBA"}</td>
                      <td style={{ padding: "10px 12px" }}>
                        <Pill label={payoutStatusLabel(t, p.status)} color={mapPayoutPillColor(p.status)} />
                        {p.status === "held" && payoutHoldReasonLabel(t, p.error_message) && (
                          <div style={{ fontSize: FS.meta, color: BRAND.red, marginTop: 4 }}>{payoutHoldReasonLabel(t, p.error_message)}</div>
                        )}
                      </td>
                      <td style={{ padding: "10px 12px" }}>
                        {/* Release: anything not yet paid out (held included).
                            Hold: only what is still on its way. Paid or failed
                            rows have nothing left to do from here. */}
                        {["queued", "ready", "scheduled", "held"].includes(p.status) ? (
                          <div style={{ display: "flex", gap: 6 }}>
                            <Btn size="sm" variant="success" onClick={() => updatePayoutStatus(p, "processed_internal")}>{t("admin.confirmReleaseBtn")}</Btn>
                            {p.status !== "held" && (
                              <Btn size="sm" variant="secondary" onClick={() => updatePayoutStatus(p, "held")}>{t("admin.confirmHoldBtn")}</Btn>
                            )}
                          </div>
                        ) : (
                          <span style={{ fontSize: FS.meta, color: BRAND.textMuted }}>{t("admin.payoutNoActions")}</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>
            </Card>
          </div>
        )}

        {view === "config" && (
          // Read-only on purpose. This screen used to show editable fields and a
          // "Save Configuration" button that saved nothing (fixed values,
          // no-op onChange, a success toast) -- and half the rules it listed
          // (wage floor, transport bands, 4h worker late-cancel) don't exist
          // anywhere. Only rules actually enforced are listed, with where each
          // lives, until a real settings table exists to edit them.
          <div style={{ maxWidth: 560 }}>
            <div style={{ ...(compact ? TYPE.titleMobile : TYPE.title), color: BRAND.text, marginBottom: 4 }}>{t("admin.configTitle")}</div>
            <div style={{ fontSize: FS.body, color: BRAND.textMuted, marginBottom: 24 }}>Rules currently in force. These are set in code and database migrations, so changing one needs a release.</div>
            {[
              ["Platform fee", platformFeePct == null ? "Loading…" : `${+(platformFeePct * 100).toFixed(2)}% on top of the wage, paid by the employer`, "platform_fee_pct() in Postgres. Each shift keeps the rate in force when it was posted."],
              ["Highest rate a worker can ask", "150% of the employer's max hourly wage", "Checked in the app when a worker applies."],
              ["Late cancellation by employer", "Under 24 hours before start: the worker chooses a 50% payout, or shows up for 100%", "Cancellation triggers in Postgres."],
            ].map(([label, value, source]) => (
              <Card key={label} style={{ marginBottom: 12 }}>
                <div style={{ fontWeight: 700, fontSize: FS.body, color: BRAND.text, marginBottom: 4 }}>{label}</div>
                <div style={{ fontSize: FS.body, color: BRAND.text, marginBottom: 6 }}>{value}</div>
                <div style={{ fontSize: FS.meta, color: BRAND.textMuted }}>{source}</div>
              </Card>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

const ADMIN_ROUTES = { overview: [], kycqueue: ["kyc"], employerqueue: ["employers"], disputes: ["disputes"], reports: ["reports"], flags: ["flags"], payouts: ["payouts"], deposits: ["deposits"], config: ["config"] };

const parseAdminRoute = (segs) => ({ view: routeKeyFromSegment(ADMIN_ROUTES, segs[0]) ?? "overview" });
const buildAdminSegments = ({ view }) => ADMIN_ROUTES[view] ?? [view];

export default AdminPortal;
