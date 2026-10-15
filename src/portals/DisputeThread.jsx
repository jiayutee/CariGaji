// The conversation behind a dispute: what was filed, what each side and the team have said,
// the photos and PDFs shared, and where it stands. Split out so nobody downloads it until a
// dispute is actually opened. Opened from anywhere via openDispute(id); the app root renders it.
import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { supabase } from "../lib/supabase.js";
import {
  BRAND, Badge, Btn, DISPUTE_CATEGORIES, DisputeAttachments, EvidencePicker, FS, Icons, InlineIcon, RADIUS, RATING_ASPECTS,
  SITE, StarRating, Z, disputeStatusLabel, displayProtectedText, formatShiftDate, formatShiftTime, uploadDisputeEvidence,
  useConfirm, useDialog, useLanguage, useToast,
} from "../../carigaji-app.jsx";

const statusColor = (s) => (s === "under_review" ? "amber" : s === "awaiting_info" ? "orange" : s === "resolved" ? "green" : s === "dismissed" ? "gray" : "blue");
const stamp = (iso) => `${formatShiftDate(iso, { day: "numeric", month: "short" })}, ${formatShiftTime(iso)}`;
const isOpenStatus = (s) => s === "open" || s === "under_review" || s === "awaiting_info";

const Bubble = ({ mine, internal, label, when, body, attachments }) => (
  <div style={{ display: "flex", flexDirection: "column", alignItems: mine ? "flex-end" : "flex-start", marginTop: 10 }}>
    <div style={{ fontSize: FS.meta, color: BRAND.textMuted, marginBottom: 3 }}>{label} · {when}</div>
    <div style={{
      maxWidth: "88%", padding: "9px 12px", borderRadius: RADIUS.control, fontSize: FS.body, lineHeight: 1.5, whiteSpace: "pre-wrap", overflowWrap: "anywhere",
      background: internal ? BRAND.amberLight : mine ? BRAND.blueLight : BRAND.grayLight,
      color: internal ? BRAND.onAmberLight : mine ? BRAND.onBlueLight : BRAND.text,
      border: `1px solid ${internal ? BRAND.amber : mine ? BRAND.blue : BRAND.border}`,
    }}>{body}</div>
    <DisputeAttachments items={attachments} />
  </div>
);

export default function DisputeThreadModal({ disputeId, user, isAdmin = false, onClose, onChanged }) {
  const { t } = useLanguage();
  const toast = useToast();
  const [confirm, confirmDialog] = useConfirm();
  const dialog = useDialog(Boolean(disputeId), onClose, { label: t("dispute.threadTitle") });
  const [dispute, setDispute] = useState(undefined);   // undefined = loading, null = not found
  const [messages, setMessages] = useState([]);
  const [attachments, setAttachments] = useState([]);
  const [text, setText] = useState("");
  const [files, setFiles] = useState([]);
  const [internal, setInternal] = useState(false);
  const [sending, setSending] = useState(false);

  const load = useCallback(async () => {
    if (!disputeId) return;
    const [d, m, a] = await Promise.all([
      supabase.from("disputes")
        .select("id, category, description, status, awaiting_role, resolution_note, resolved_at, created_at, filed_by, filed_by_role, rating_id, application:applications(id, worker_id, worker:profiles!applications_worker_id_profiles_fkey(full_name), shift:shifts(id, title, employer_id, employer:profiles(full_name))), rating:ratings(id, overall, aspects, comment, direction, hidden_at, hide_reason)")
        .eq("id", disputeId).maybeSingle(),
      supabase.from("dispute_messages").select("id, author_id, author_role, body, is_internal, created_at").eq("dispute_id", disputeId).order("created_at", { ascending: true }),
      supabase.from("dispute_attachments").select("id, message_id, uploader_id, storage_path, file_name, mime_type, size_bytes, created_at").eq("dispute_id", disputeId).order("created_at", { ascending: true }),
    ]);
    setDispute(d.error ? null : (d.data ?? null));
    setMessages(m.data ?? []);
    setAttachments(a.data ?? []);
  }, [disputeId]);

  useEffect(() => {
    if (!disputeId) return undefined;
    setDispute(undefined); setMessages([]); setAttachments([]); setText(""); setFiles([]); setInternal(false);
    load();
    // Light polling while it is open, so a reply from the other side or the team appears
    // without reopening.
    const timer = setInterval(load, 20000);
    return () => clearInterval(timer);
  }, [disputeId, load]);

  if (!disputeId) return null;

  const app = dispute?.application;
  const myRole = isAdmin ? "admin" : app?.worker_id === user?.id ? "worker" : "employer";
  const open = dispute ? isOpenStatus(dispute.status) : false;
  const workerName = app?.worker?.full_name || t("dispute.roleWorker");
  const employerName = app?.shift?.employer?.full_name || t("dispute.roleEmployer");
  const nameFor = (role) => (role === "worker" ? `${workerName} (${t("dispute.roleWorker")})` : role === "employer" ? `${employerName} (${t("dispute.roleEmployer")})` : t("dispute.roleTeam", { brand: SITE.name }));
  const labelFor = (role, authorId) => (authorId === user?.id && !isAdmin ? t("dispute.you") : nameFor(role));
  const category = DISPUTE_CATEGORIES.find(c => c.value === dispute?.category);
  const categoryLabel = dispute?.category === "review_report" ? t("dispute.categoryReviewReport") : t(category?.labelKey ?? "dispute.categoryOther");
  const asked = dispute?.status === "awaiting_info" ? dispute.awaiting_role : null;

  const changed = async () => { await load(); onChanged?.(); };

  const send = async () => {
    const body = text.trim();
    if (!body || sending || !dispute) return;
    setSending(true);
    const { data, error } = await supabase.from("dispute_messages")
      .insert({ dispute_id: dispute.id, author_id: user.id, author_role: myRole, body, is_internal: isAdmin && internal })
      .select("id").single();
    if (error) { setSending(false); toast(t("dispute.sendFailed") + error.message, "error"); return; }
    let failed = [];
    if (files.length) failed = await uploadDisputeEvidence({ disputeId: dispute.id, files, messageId: data.id, userId: user.id });
    setSending(false);
    setText(""); setFiles([]);
    if (failed.length) toast(t("dispute.evidenceUploadFailedReply", { names: failed.join(", ") }), "error");
    await changed();
  };

  // ── team actions ──
  const patch = async (fields, okKey) => {
    const { error } = await supabase.from("disputes").update(fields).eq("id", dispute.id);
    if (error) { toast(t("dispute.updateFailed") + error.message, "error"); return false; }
    if (okKey) toast(t(okKey), "success");
    await changed();
    return true;
  };
  const close = async (status) => {
    const ok = await confirm({
      title: t(status === "resolved" ? "dispute.confirmResolveTitle" : "dispute.confirmDismissTitle"),
      body: t("dispute.confirmCloseBody"),
      confirmLabel: t(status === "resolved" ? "admin.disputeResolve" : "admin.disputeDismiss"),
      tone: status === "resolved" ? "success" : "danger",
      note: { label: t("dispute.resolutionNoteLabel"), required: true },
    });
    if (!ok) return;
    await patch({ status, resolution_note: ok.note, resolved_by: user.id, resolved_at: new Date().toISOString() }, status === "resolved" ? "admin.disputeResolved" : "admin.disputeDismissed");
  };
  const askFor = async (role) => {
    await patch({ status: "awaiting_info", awaiting_role: role }, "dispute.askedForInfo");
  };
  const setReviewHidden = async (hide) => {
    const ok = await confirm({
      title: t(hide ? "dispute.hideReviewTitle" : "dispute.restoreReviewTitle"),
      body: t(hide ? "dispute.hideReviewBody" : "dispute.restoreReviewBody"),
      confirmLabel: t(hide ? "dispute.hideReviewBtn" : "dispute.restoreReviewBtn"),
      tone: hide ? "danger" : "primary",
      note: hide ? { label: t("dispute.hideReasonLabel"), required: true } : undefined,
    });
    if (!ok) return;
    const { error } = await supabase.rpc("admin_set_review_visibility", { p_rating_id: dispute.rating_id, p_hide: hide, p_reason: ok.note || null });
    if (error) { toast(t("dispute.updateFailed") + error.message, "error"); return; }
    toast(t(hide ? "dispute.reviewHidden" : "dispute.reviewRestored"), "success");
    await changed();
  };

  const filingAttachments = attachments.filter(a => !a.message_id);
  const visibleMessages = isAdmin ? messages : messages.filter(m => !m.is_internal);
  const statusLine = !dispute ? "" :
    dispute.status === "open" ? t("dispute.statusLineOpen")
    : dispute.status === "under_review" ? t("dispute.statusLineReview")
    : dispute.status === "awaiting_info" ? (asked === myRole ? t("dispute.statusLineAwaitingMe") : t("dispute.statusLineAwaitingOther", { who: nameFor(asked) }))
    : dispute.status === "resolved" ? t("dispute.statusLineResolved")
    : t("dispute.statusLineDismissed");

  const rating = dispute?.rating;
  const aspects = rating ? (RATING_ASPECTS[rating.direction] ?? []) : [];

  return createPortal(
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: BRAND.overlay, zIndex: Z.modal, display: "flex", alignItems: "center", justifyContent: "center", padding: 12 }}>
      <div {...dialog} onClick={e => e.stopPropagation()} style={{ background: BRAND.surface, borderRadius: RADIUS.card, width: "100%", maxWidth: 580, maxHeight: "92vh", display: "flex", flexDirection: "column", border: `1px solid ${BRAND.border}` }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10, padding: "16px 18px 10px" }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: FS.lead, fontWeight: 800, color: BRAND.text, lineHeight: 1.25 }}>{categoryLabel}</div>
            <div style={{ fontSize: FS.meta, color: BRAND.textMuted, marginTop: 2 }}>{displayProtectedText(app?.shift?.title ?? "")}</div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
            {dispute && <Badge color={statusColor(dispute.status)}>{disputeStatusLabel(dispute.status, t)}</Badge>}
            <button onClick={onClose} aria-label={t("common.close")} style={{ border: "none", background: "transparent", cursor: "pointer", color: BRAND.textMuted, padding: 4, display: "flex" }}><Icons.Close size={20} /></button>
          </div>
        </div>

        <div style={{ overflowY: "auto", padding: "0 18px 14px", flex: "1 1 auto", minHeight: 150 }}>
          {dispute === undefined && <div style={{ color: BRAND.textMuted, fontSize: FS.meta, padding: 12 }}>{t("common.loading")}</div>}
          {dispute === null && <div style={{ color: BRAND.textMuted, fontSize: FS.meta, padding: 12 }}>{t("dispute.notFound")}</div>}
          {dispute && (
            <>
              {/* Where it stands, in a sentence. */}
              <div style={{ padding: "8px 12px", borderRadius: RADIUS.control, fontSize: FS.meta, fontWeight: 600, lineHeight: 1.45, marginBottom: 6,
                background: asked === myRole ? BRAND.amberLight : BRAND.grayLight, color: asked === myRole ? BRAND.onAmberLight : BRAND.text, border: `1px solid ${asked === myRole ? BRAND.amber : BRAND.border}` }}>
                <InlineIcon icon={asked === myRole ? Icons.Alert : Icons.Info} />{statusLine}
              </div>
              {!open && dispute.resolution_note && (
                <div style={{ padding: "9px 12px", borderRadius: RADIUS.control, background: dispute.status === "resolved" ? BRAND.greenLight : BRAND.grayLight, color: dispute.status === "resolved" ? BRAND.onGreenLight : BRAND.text, fontSize: FS.body, lineHeight: 1.5, whiteSpace: "pre-wrap", overflowWrap: "anywhere", marginBottom: 6 }}>
                  <div style={{ fontSize: FS.meta, fontWeight: 700, marginBottom: 2 }}>{t("dispute.outcomeLabel")}{dispute.resolved_at ? ` · ${formatShiftDate(dispute.resolved_at, { day: "numeric", month: "short", year: "numeric" })}` : ""}</div>
                  {dispute.resolution_note}
                </div>
              )}

              {/* The review being challenged. */}
              {dispute.category === "review_report" && (
                <div style={{ padding: "10px 12px", borderRadius: RADIUS.control, border: `1px solid ${BRAND.border}`, margin: "8px 0" }}>
                  <div style={{ fontSize: FS.meta, fontWeight: 700, color: BRAND.textMuted, marginBottom: 6 }}>{t("dispute.reviewReported")}</div>
                  {rating ? (
                    <>
                      <StarRating value={Number(rating.overall)} size={14} />
                      <div style={{ display: "flex", flexWrap: "wrap", gap: "2px 12px", marginTop: 6, fontSize: FS.meta, color: BRAND.textMuted }}>
                        {aspects.map(a => <span key={a.value}>{t(a.labelKey)} {Number(rating.aspects?.[a.value] ?? 0).toFixed(0)}</span>)}
                      </div>
                      {rating.comment && <div style={{ marginTop: 6, fontSize: FS.body, color: BRAND.text, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>“{rating.comment}”</div>}
                      {isAdmin && rating.hidden_at && <div style={{ marginTop: 6, fontSize: FS.meta, color: BRAND.redOnSurface, fontWeight: 600 }}>{t("dispute.reviewIsHidden", { reason: rating.hide_reason || "—" })}</div>}
                    </>
                  ) : <div style={{ fontSize: FS.meta, color: BRAND.textMuted }}>{t("dispute.reviewNoLongerShown")}</div>}
                  {isAdmin && rating && (
                    <div style={{ marginTop: 8 }}>
                      {rating.hidden_at
                        ? <Btn size="xs" variant="secondary" onClick={() => setReviewHidden(false)}>{t("dispute.restoreReviewBtn")}</Btn>
                        : <Btn size="xs" variant="danger" onClick={() => setReviewHidden(true)}>{t("dispute.hideReviewBtn")}</Btn>}
                    </div>
                  )}
                </div>
              )}

              {/* The filing itself. */}
              <Bubble
                mine={dispute.filed_by === user?.id && !isAdmin}
                label={`${labelFor(dispute.filed_by_role, dispute.filed_by)} · ${t("dispute.filedLabel")}`}
                when={stamp(dispute.created_at)}
                body={dispute.description}
                attachments={filingAttachments}
              />
              {visibleMessages.map(m => (
                <Bubble
                  key={m.id}
                  mine={m.author_id === user?.id && !isAdmin}
                  internal={m.is_internal}
                  label={m.is_internal ? t("dispute.internalNoteLabel") : labelFor(m.author_role, m.author_id)}
                  when={stamp(m.created_at)}
                  body={m.body}
                  attachments={attachments.filter(a => a.message_id === m.id)}
                />
              ))}
            </>
          )}
        </div>

        {dispute && open && (
          <div style={{ borderTop: `1px solid ${BRAND.border}`, padding: "10px 18px 12px" }}>
            <textarea
              value={text}
              onChange={e => setText(e.target.value)}
              rows={2}
              maxLength={2000}
              placeholder={t(isAdmin ? "dispute.replyPlaceholderTeam" : "dispute.replyPlaceholder")}
              aria-label={t("dispute.replyLabel")}
              style={{ width: "100%", boxSizing: "border-box", padding: "10px 12px", borderRadius: RADIUS.control, border: `1px solid ${BRAND.border}`, background: BRAND.input, color: BRAND.text, fontSize: FS.body, fontFamily: "inherit", resize: "vertical", marginBottom: 8 }}
            />
            {isAdmin && (
              <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: FS.meta, color: BRAND.text, marginBottom: 8 }}>
                <input type="checkbox" checked={internal} onChange={e => setInternal(e.target.checked)} />{t("dispute.internalToggle")}
              </label>
            )}
            <EvidencePicker files={files} onChange={setFiles} disabled={sending} compact />
            <Btn onClick={send} disabled={sending || !text.trim()} style={{ width: "100%", justifyContent: "center" }}>{sending ? "…" : t("dispute.sendBtn")}</Btn>
          </div>
        )}
        {dispute && !open && !isAdmin && (
          <div style={{ borderTop: `1px solid ${BRAND.border}`, padding: "10px 18px", fontSize: FS.meta, color: BRAND.textMuted }}>{t("dispute.closedNotice")}</div>
        )}

        {dispute && isAdmin && (
          <div style={{ borderTop: `1px solid ${BRAND.border}`, padding: "10px 18px 14px", display: "flex", gap: 8, flexWrap: "wrap" }}>
            {open ? (
              <>
                {dispute.status === "open" && <Btn size="sm" variant="secondary" onClick={() => patch({ status: "under_review" }, "dispute.markedUnderReview")}>{t("admin.disputeMarkUnderReview")}</Btn>}
                <Btn size="sm" variant="secondary" onClick={() => askFor("worker")}>{t("dispute.askWorker")}</Btn>
                <Btn size="sm" variant="secondary" onClick={() => askFor("employer")}>{t("dispute.askEmployer")}</Btn>
                <Btn size="sm" variant="success" onClick={() => close("resolved")}>{t("admin.disputeResolve")}</Btn>
                <Btn size="sm" variant="secondary" onClick={() => close("dismissed")}>{t("admin.disputeDismiss")}</Btn>
              </>
            ) : (
              <Btn size="sm" variant="secondary" onClick={() => patch({ status: "under_review", resolution_note: null, resolved_at: null, resolved_by: null }, "dispute.reopened")}>{t("dispute.reopen")}</Btn>
            )}
          </div>
        )}
      </div>
      {confirmDialog}
    </div>,
    document.body
  );
}
