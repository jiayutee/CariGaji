import { useState, useEffect, useRef } from "react";

// ─── Design tokens ─────────────────────────────────────────────────────────
const BRAND = {
  primary: "#E8380D",
  primaryLight: "#FFF0ED",
  primaryMid: "#F7C5BA",
  dark: "#1A0A06",
  accent: "#F5A623",
  accentLight: "#FEF6E7",
  green: "#1A9E5C",
  greenLight: "#E8F7EF",
  blue: "#1A6BE8",
  blueLight: "#E8F0FE",
  amber: "#D97706",
  amberLight: "#FEF3C7",
  red: "#DC2626",
  redLight: "#FEE2E2",
  gray: "#6B7280",
  grayLight: "#F9FAFB",
  border: "#E5E7EB",
  text: "#111827",
  textMuted: "#6B7280",
};

// ─── Shared helpers ─────────────────────────────────────────────────────────
const Badge = ({ color = "gray", children, size = "sm" }) => {
  const map = {
    gray: { bg: "#F3F4F6", text: "#374151" },
    green: { bg: BRAND.greenLight, text: "#065F46" },
    red: { bg: BRAND.redLight, text: "#991B1B" },
    amber: { bg: BRAND.amberLight, text: "#92400E" },
    blue: { bg: BRAND.blueLight, text: "#1E40AF" },
    orange: { bg: BRAND.primaryLight, text: "#9A3412" },
    teal: { bg: "#CCFBF1", text: "#0F766E" },
  };
  const c = map[color] || map.gray;
  return (
    <span style={{
      display: "inline-flex", alignItems: "center",
      padding: size === "xs" ? "1px 6px" : "2px 10px",
      borderRadius: 99,
      fontSize: size === "xs" ? 10 : 11,
      fontWeight: 600,
      letterSpacing: "0.02em",
      background: c.bg, color: c.text,
      whiteSpace: "nowrap",
    }}>{children}</span>
  );
};

const Card = ({ children, style = {}, onClick, hover = false }) => (
  <div onClick={onClick} style={{
    background: "#fff",
    border: `1px solid ${BRAND.border}`,
    borderRadius: 16,
    padding: "20px 24px",
    cursor: onClick ? "pointer" : "default",
    transition: "box-shadow 0.15s, transform 0.15s",
    ...style,
  }}
    onMouseEnter={e => { if (hover || onClick) { e.currentTarget.style.boxShadow = "0 4px 20px rgba(0,0,0,0.08)"; e.currentTarget.style.transform = "translateY(-1px)"; } }}
    onMouseLeave={e => { e.currentTarget.style.boxShadow = "none"; e.currentTarget.style.transform = "none"; }}
  >{children}</div>
);

const Btn = ({ children, variant = "primary", onClick, size = "md", style = {}, disabled = false }) => {
  const base = {
    display: "inline-flex", alignItems: "center", gap: 6,
    border: "none", borderRadius: 10, cursor: disabled ? "not-allowed" : "pointer",
    fontWeight: 600, fontFamily: "inherit",
    transition: "all 0.15s", opacity: disabled ? 0.5 : 1,
    fontSize: size === "sm" ? 13 : size === "xs" ? 12 : 14,
    padding: size === "sm" ? "7px 14px" : size === "xs" ? "4px 10px" : "10px 20px",
  };
  const variants = {
    primary: { background: BRAND.primary, color: "#fff" },
    secondary: { background: BRAND.grayLight, color: BRAND.text, border: `1px solid ${BRAND.border}` },
    ghost: { background: "transparent", color: BRAND.primary, border: `1px solid ${BRAND.primary}` },
    danger: { background: BRAND.red, color: "#fff" },
    success: { background: BRAND.green, color: "#fff" },
  };
  return (
    <button onClick={disabled ? undefined : onClick} style={{ ...base, ...variants[variant], ...style }}
      onMouseEnter={e => { if (!disabled) e.currentTarget.style.opacity = "0.85"; }}
      onMouseLeave={e => { e.currentTarget.style.opacity = "1"; }}
    >{children}</button>
  );
};

const Avatar = ({ name = "?", size = 36, color = BRAND.primary }) => {
  const initials = name.split(" ").map(w => w[0]).slice(0, 2).join("").toUpperCase();
  return (
    <div style={{
      width: size, height: size, borderRadius: "50%",
      background: color + "22", color: color,
      display: "flex", alignItems: "center", justifyContent: "center",
      fontSize: size * 0.35, fontWeight: 700, flexShrink: 0,
    }}>{initials}</div>
  );
};

const Stat = ({ label, value, sub, color = BRAND.primary }) => (
  <div style={{ background: BRAND.grayLight, borderRadius: 14, padding: "16px 20px" }}>
    <div style={{ fontSize: 12, color: BRAND.textMuted, fontWeight: 500, marginBottom: 4 }}>{label}</div>
    <div style={{ fontSize: 26, fontWeight: 800, color, lineHeight: 1 }}>{value}</div>
    {sub && <div style={{ fontSize: 11, color: BRAND.textMuted, marginTop: 4 }}>{sub}</div>}
  </div>
);

const Input = ({ label, placeholder, value, onChange, type = "text", style = {} }) => (
  <div style={{ marginBottom: 16, ...style }}>
    {label && <label style={{ display: "block", fontSize: 13, fontWeight: 600, color: BRAND.text, marginBottom: 6 }}>{label}</label>}
    <input type={type} placeholder={placeholder} value={value} onChange={onChange}
      style={{
        width: "100%", padding: "10px 14px", borderRadius: 10,
        border: `1px solid ${BRAND.border}`, fontSize: 14, fontFamily: "inherit",
        color: BRAND.text, background: "#fff", outline: "none",
        boxSizing: "border-box",
      }}
    />
  </div>
);

const Select = ({ label, options, value, onChange, style = {} }) => (
  <div style={{ marginBottom: 16, ...style }}>
    {label && <label style={{ display: "block", fontSize: 13, fontWeight: 600, color: BRAND.text, marginBottom: 6 }}>{label}</label>}
    <select value={value} onChange={onChange} style={{
      width: "100%", padding: "10px 14px", borderRadius: 10,
      border: `1px solid ${BRAND.border}`, fontSize: 14, fontFamily: "inherit",
      color: BRAND.text, background: "#fff", outline: "none",
    }}>
      {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  </div>
);

const Pill = ({ label, color }) => (
  <span style={{
    display: "inline-block", padding: "2px 10px", borderRadius: 99,
    fontSize: 11, fontWeight: 600,
    background: color === "green" ? BRAND.greenLight : color === "red" ? BRAND.redLight : color === "amber" ? BRAND.amberLight : color === "blue" ? BRAND.blueLight : "#F3F4F6",
    color: color === "green" ? "#065F46" : color === "red" ? "#991B1B" : color === "amber" ? "#92400E" : color === "blue" ? "#1E40AF" : "#374151",
  }}>{label}</span>
);

const StarRating = ({ value = 4.5, size = 14 }) => {
  const stars = [];
  for (let i = 1; i <= 5; i++) {
    stars.push(
      <span key={i} style={{ color: i <= Math.round(value) ? BRAND.accent : "#D1D5DB", fontSize: size }}>★</span>
    );
  }
  return <span>{stars} <span style={{ fontSize: size - 2, color: BRAND.textMuted }}>({value})</span></span>;
};

const Progress = ({ value, max = 100, color = BRAND.primary }) => (
  <div style={{ height: 6, background: "#F3F4F6", borderRadius: 99, overflow: "hidden" }}>
    <div style={{ height: "100%", width: `${(value / max) * 100}%`, background: color, borderRadius: 99, transition: "width 0.3s" }} />
  </div>
);

// ─── Mock data ───────────────────────────────────────────────────────────────
const SHIFTS = [
  { id: 1, title: "F&B Server – Wedding Banquet", employer: "Grand Hyatt KL", category: "F&B", date: "15 Jun 2025", time: "18:00–23:00", hours: 5, wageMin: 12, wageMax: 16, location: "KL City Centre", distance: 8.2, travelTime: "~45 min", stipend: 5, headcount: 8, filled: 3, status: "open", dress: "All black formal", reliabilityScore: 94, rating: 4.7, totalApplicants: 14 },
  { id: 2, title: "Retail Promoter – Tech Expo", employer: "Maxis Berhad", category: "Retail", date: "18 Jun 2025", time: "10:00–18:00", hours: 8, wageMin: 14, wageMax: 18, location: "KLCC", distance: 3.1, travelTime: "~20 min", stipend: 0, headcount: 4, filled: 1, status: "open", dress: "Smart casual – company polo provided", reliabilityScore: 98, rating: 4.9, totalApplicants: 22 },
  { id: 3, title: "Event Crew – Music Festival", employer: "Live Nation MY", category: "Event", date: "21 Jun 2025", time: "14:00–00:00", hours: 10, wageMin: 15, wageMax: 20, location: "Stadium Merdeka", distance: 12.5, travelTime: "~55 min", stipend: 10, headcount: 20, filled: 12, status: "open", dress: "Black t-shirt + jeans", reliabilityScore: 87, rating: 4.2, totalApplicants: 41 },
  { id: 4, title: "Warehouse Packer – Flash Sale", employer: "Shopee MY", category: "Logistics", date: "20 Jun 2025", time: "08:00–16:00", hours: 8, wageMin: 11, wageMax: 14, location: "Shah Alam", distance: 28.4, travelTime: "~70 min", stipend: 10, headcount: 15, filled: 15, status: "filled", dress: "Casual, closed-toe shoes", reliabilityScore: 91, rating: 4.5, totalApplicants: 58 },
  { id: 5, title: "Barista – Pop-up Café", employer: "Artisan Roast Co.", category: "F&B", date: "22 Jun 2025", time: "09:00–15:00", hours: 6, wageMin: 13, wageMax: 17, location: "Bangsar", distance: 5.8, travelTime: "~30 min", stipend: 5, headcount: 2, filled: 0, status: "open", dress: "Smart casual, apron provided", reliabilityScore: 96, rating: 4.8, totalApplicants: 7 },
];

const APPLICATIONS = [
  { id: 1, shiftId: 2, shiftTitle: "Retail Promoter – Tech Expo", employer: "Maxis Berhad", date: "18 Jun 2025", wageBid: 16, status: "shortlisted", appliedAt: "2 days ago" },
  { id: 2, shiftId: 1, shiftTitle: "F&B Server – Wedding Banquet", employer: "Grand Hyatt KL", date: "15 Jun 2025", wageBid: 14, status: "pending", appliedAt: "1 day ago" },
  { id: 3, shiftId: 5, shiftTitle: "Barista – Pop-up Café", employer: "Artisan Roast Co.", date: "22 Jun 2025", wageBid: 15, status: "accepted", appliedAt: "3 hours ago" },
];

const EMPLOYER_SHIFTS = [
  { id: 1, title: "F&B Server – Wedding Banquet", date: "15 Jun 2025", time: "18:00–23:00", headcount: 8, filled: 6, applicants: 14, status: "open", escrow: 640, category: "F&B" },
  { id: 2, title: "Kitchen Helper – Corporate Lunch", date: "12 Jun 2025", time: "09:00–14:00", headcount: 3, filled: 3, applicants: 9, status: "completed", escrow: 180, category: "F&B" },
  { id: 3, title: "Waitstaff – Gala Dinner", date: "25 Jun 2025", time: "19:00–00:00", headcount: 10, filled: 0, applicants: 0, status: "draft", escrow: 0, category: "F&B" },
];

const EMPLOYER_APPLICANTS = [
  { id: 1, name: "Ahmad Firdaus", kyc: "Standard", reliability: 94, rating: 4.7, wageBid: 14, status: "shortlisted", completedShifts: 38 },
  { id: 2, name: "Nurul Ain Binti Hassan", kyc: "Standard", reliability: 98, rating: 4.9, wageBid: 15, status: "shortlisted", completedShifts: 72 },
  { id: 3, name: "Wei Jian Lim", kyc: "Basic", reliability: 71, rating: 4.1, wageBid: 12, status: "pending", completedShifts: 5 },
  { id: 4, name: "Priya Selvam", kyc: "Standard", reliability: 88, rating: 4.5, wageBid: 16, status: "pending", completedShifts: 22 },
  { id: 5, name: "Hafiz Roslan", kyc: "Advanced", reliability: 99, rating: 5.0, wageBid: 15, status: "accepted", completedShifts: 156 },
];

const ADMIN_KYC = [
  { id: 1, name: "Muhammad Izzat", type: "Standard", submitted: "2 hours ago", status: "pending", docs: ["MyKad front", "MyKad back", "Selfie"] },
  { id: 2, name: "Siti Rahmah Binti Ali", type: "Standard", submitted: "4 hours ago", status: "pending", docs: ["MyKad front", "MyKad back", "Selfie"] },
  { id: 3, name: "Chong Wei Han", type: "Advanced", submitted: "1 day ago", status: "flagged", docs: ["MyKad front", "MyKad back", "Selfie", "Food Handler Cert"] },
  { id: 4, name: "Rubini Krishnan", type: "Standard", submitted: "1 day ago", status: "pending", docs: ["MyKad front", "MyKad back", "Selfie"] },
];

const ADMIN_DISPUTES = [
  { id: "D-001", worker: "Ahmad Firdaus", employer: "Grand Hyatt KL", shift: "F&B Server – Wedding Banquet", reason: "Hours disputed", amount: 70, status: "under_review", opened: "2 days ago" },
  { id: "D-002", worker: "Wei Jian Lim", employer: "Live Nation MY", shift: "Event Crew – Music Festival", reason: "No-show claim by employer", amount: 150, status: "open", opened: "1 day ago" },
  { id: "D-003", worker: "Priya Selvam", employer: "Shopee MY", shift: "Warehouse Packer – Flash Sale", reason: "Unsafe working conditions", amount: 88, status: "escalated", opened: "5 days ago" },
];

const CHAT_MESSAGES = [
  { id: 1, from: "employer", name: "Grand Hyatt KL", text: "Hi! We reviewed your application. Your experience looks great. Do you have experience with silver service?", time: "10:32 AM" },
  { id: 2, from: "worker", name: "You", text: "Yes, I have 2 years of silver service experience from my previous role at Shangri-La.", time: "10:45 AM" },
  { id: 3, from: "employer", name: "Grand Hyatt KL", text: "Perfect! We'd like to offer you the shift at RM14/h. Please review the contract details.", time: "11:00 AM" },
  { id: 4, from: "system", text: "📋 Offer sent: RM14/h × 5 hours = RM70 total. Tap to view and accept.", time: "11:00 AM" },
];

// ─── WORKER PORTAL ───────────────────────────────────────────────────────────
const WorkerPortal = ({ onOpenPortal, isMobile = false }) => {
  const [tab, setTab] = useState("discover");
  const [selectedShift, setSelectedShift] = useState(null);
  const [showBidModal, setShowBidModal] = useState(false);
  const [bidAmount, setBidAmount] = useState("");
  const [showChat, setShowChat] = useState(false);
  const [chatMsg, setChatMsg] = useState("");
  const [messages, setMessages] = useState(CHAT_MESSAGES);
  const [bidSuccess, setBidSuccess] = useState(false);
  const [filterCat, setFilterCat] = useState("All");
  const [showQR, setShowQR] = useState(false);

  const cats = ["All", "F&B", "Retail", "Event", "Logistics"];
  const filtered = filterCat === "All" ? SHIFTS.filter(s => s.status === "open") : SHIFTS.filter(s => s.category === filterCat && s.status === "open");

  const sendMsg = () => {
    if (!chatMsg.trim()) return;
    setMessages(m => [...m, { id: m.length + 1, from: "worker", name: "You", text: chatMsg, time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) }]);
    setChatMsg("");
  };

  const navItems = [
    { id: "discover", label: "Discover", icon: "🔍" },
    { id: "applications", label: "My Bids", icon: "📋" },
    { id: "earnings", label: "Earnings", icon: "💰" },
    { id: "profile", label: "Profile", icon: "👤" },
    { id: "settings", label: "Settings", icon: "⚙️" },
  ];

  if (showQR) return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "100%", padding: 32, background: "#fff", borderRadius: 16 }}>
      <div style={{ fontSize: 24, fontWeight: 800, color: BRAND.text, marginBottom: 8 }}>Check-in QR Scanner</div>
      <div style={{ color: BRAND.textMuted, fontSize: 14, marginBottom: 32, textAlign: "center" }}>Point your camera at the QR code at the venue entrance</div>
      <div style={{ width: 220, height: 220, background: BRAND.grayLight, borderRadius: 20, display: "flex", alignItems: "center", justifyContent: "center", border: `3px dashed ${BRAND.border}`, marginBottom: 24 }}>
        <div style={{ textAlign: "center" }}>
          <div style={{ fontSize: 48 }}>📷</div>
          <div style={{ fontSize: 12, color: BRAND.textMuted, marginTop: 8 }}>Camera viewfinder</div>
        </div>
      </div>
      <div style={{ background: BRAND.greenLight, color: "#065F46", borderRadius: 12, padding: "12px 20px", fontSize: 14, fontWeight: 600, marginBottom: 16 }}>✓ GPS: KLCC (1.5km — within range)</div>
      <Btn onClick={() => { setShowQR(false); alert("✅ Checked in at 18:02! Reliability +0 (on time)"); }}>Simulate Successful Check-in</Btn>
      <Btn variant="secondary" onClick={() => setShowQR(false)} style={{ marginTop: 8 }}>Back</Btn>
    </div>
  );

  if (showChat) return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div style={{ padding: "16px 20px", borderBottom: `1px solid ${BRAND.border}`, display: "flex", alignItems: "center", gap: 12, background: "#fff" }}>
        <button onClick={() => setShowChat(false)} style={{ background: "none", border: "none", fontSize: 20, cursor: "pointer", color: BRAND.text }}>←</button>
        <Avatar name="Grand Hyatt KL" size={36} color={BRAND.blue} />
        <div>
          <div style={{ fontWeight: 700, fontSize: 14, color: BRAND.text }}>Grand Hyatt KL</div>
          <div style={{ fontSize: 12, color: BRAND.green }}>● Online</div>
        </div>
        <div style={{ marginLeft: "auto" }}>
          <Badge color="orange">F&B Server Shift</Badge>
        </div>
      </div>
      <div style={{ flex: 1, overflowY: "auto", padding: 16, display: "flex", flexDirection: "column", gap: 12, background: BRAND.grayLight }}>
        {messages.map(m => (
          <div key={m.id} style={{ display: "flex", flexDirection: "column", alignItems: m.from === "system" ? "center" : m.from === "worker" ? "flex-end" : "flex-start" }}>
            {m.from === "system" ? (
              <div style={{ background: BRAND.amberLight, border: `1px solid ${BRAND.accent}30`, borderRadius: 12, padding: "10px 16px", fontSize: 13, color: BRAND.amber, maxWidth: "85%", textAlign: "center", cursor: "pointer" }}
                onClick={() => alert("📋 Offer: RM14/h × 5 hours = RM70 total\nTravel stipend: RM5\nStart: 15 Jun 18:00\nDress: All black formal\n\nAccept or Decline?")}>
                {m.text}
              </div>
            ) : (
              <div style={{ background: m.from === "worker" ? BRAND.primary : "#fff", borderRadius: 14, padding: "10px 14px", maxWidth: "75%", border: m.from === "employer" ? `1px solid ${BRAND.border}` : "none" }}>
                <div style={{ fontSize: 13, color: m.from === "worker" ? "#fff" : BRAND.text, lineHeight: 1.5 }}>{m.text}</div>
                <div style={{ fontSize: 10, color: m.from === "worker" ? "rgba(255,255,255,0.7)" : BRAND.textMuted, marginTop: 4 }}>{m.time}</div>
              </div>
            )}
          </div>
        ))}
      </div>
      <div style={{ padding: 16, borderTop: `1px solid ${BRAND.border}`, background: "#fff", display: "flex", gap: 8 }}>
        <input value={chatMsg} onChange={e => setChatMsg(e.target.value)} onKeyDown={e => e.key === "Enter" && sendMsg()}
          placeholder="Type a message…"
          style={{ flex: 1, padding: "10px 14px", borderRadius: 10, border: `1px solid ${BRAND.border}`, fontSize: 14, fontFamily: "inherit", outline: "none" }}
        />
        <Btn onClick={sendMsg}>Send</Btn>
      </div>
    </div>
  );

  if (selectedShift) return (
    <div style={{ overflowY: "auto", height: "100%" }}>
      {showBidModal && (
        <div style={{ position: "absolute", inset: 0, background: "rgba(0,0,0,0.4)", display: "flex", alignItems: "flex-end", zIndex: 100, borderRadius: 20 }}>
          <div style={{ background: "#fff", borderRadius: "20px 20px 0 0", padding: 24, width: "100%" }}>
            <div style={{ fontWeight: 800, fontSize: 18, color: BRAND.text, marginBottom: 4 }}>Place Your Bid</div>
            <div style={{ fontSize: 13, color: BRAND.textMuted, marginBottom: 20 }}>
              Employer range: RM{selectedShift.wageMin}–RM{selectedShift.wageMax}/h · Max bid: RM{(selectedShift.wageMax * 1.5).toFixed(0)}/h
            </div>
            <Input label="Your wage ask (RM/hour)" type="number" placeholder={`e.g. ${selectedShift.wageMin + 1}`} value={bidAmount} onChange={e => setBidAmount(e.target.value)} />
            {bidAmount && (
              <div style={{ background: BRAND.grayLight, borderRadius: 12, padding: "12px 16px", marginBottom: 16 }}>
                <div style={{ fontSize: 13, color: BRAND.textMuted }}>Estimated total pay</div>
                <div style={{ fontSize: 22, fontWeight: 800, color: BRAND.green }}>RM{(parseFloat(bidAmount || 0) * selectedShift.hours).toFixed(0)}</div>
                <div style={{ fontSize: 12, color: BRAND.textMuted }}>+ RM{selectedShift.stipend} travel stipend</div>
              </div>
            )}
            <div style={{ display: "flex", gap: 10 }}>
              <Btn variant="secondary" onClick={() => setShowBidModal(false)} style={{ flex: 1 }}>Cancel</Btn>
              <Btn onClick={() => {
                if (!bidAmount) return;
                if (parseFloat(bidAmount) > selectedShift.wageMax * 1.5) { alert(`Max bid is RM${(selectedShift.wageMax * 1.5).toFixed(0)}/h`); return; }
                setShowBidModal(false); setBidSuccess(true);
                setTimeout(() => { setBidSuccess(false); setSelectedShift(null); setTab("applications"); }, 2000);
              }} style={{ flex: 1 }}>Submit Bid →</Btn>
            </div>
          </div>
        </div>
      )}
      {bidSuccess && (
        <div style={{ position: "absolute", inset: 0, background: "rgba(0,0,0,0.5)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 200, borderRadius: 20 }}>
          <div style={{ background: "#fff", borderRadius: 20, padding: isMobile ? 24 : 32, textAlign: "center" }}>
            <div style={{ fontSize: isMobile ? 40 : 48, marginBottom: 12 }}>🎉</div>
            <div style={{ fontWeight: 800, fontSize: isMobile ? 18 : 20, color: BRAND.text }}>Bid Submitted!</div>
            <div style={{ color: BRAND.textMuted, fontSize: isMobile ? 12 : 14, marginTop: 8 }}>RM{bidAmount}/h · You'll be notified when shortlisted</div>
          </div>
        </div>
      )}
      <div style={{ position: "relative" }}>
        <div style={{ background: `linear-gradient(135deg, ${BRAND.primary}, #C0280A)`, padding: isMobile ? "32px 16px 16px" : "48px 24px 24px", borderRadius: isMobile ? 0 : "0 0 24px 24px" }}>
          <button onClick={() => setSelectedShift(null)} style={{ background: "rgba(255,255,255,0.2)", border: "none", color: "#fff", borderRadius: 8, padding: "6px 12px", cursor: "pointer", fontSize: 13, marginBottom: 12, fontFamily: "inherit" }}>← Back</button>
          <div style={{ display: "flex", gap: 6, marginBottom: 12, flexWrap: "wrap" }}>
            <Badge color="amber">{selectedShift.category}</Badge>
            <Badge color="green">Positions {selectedShift.headcount}</Badge>
            <Badge color="blue">Applied {selectedShift.totalApplicants}</Badge>
          </div>
          <div style={{ fontSize: isMobile ? 18 : 22, fontWeight: 800, color: "#fff", lineHeight: 1.2, marginBottom: 8 }}>{selectedShift.title}</div>
          <div style={{ fontSize: isMobile ? 12 : 14, color: "rgba(255,255,255,0.85)" }}>{selectedShift.employer}</div>
        </div>
        <div style={{ padding: isMobile ? 14 : 20 }}>
          <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr 1fr" : "1fr 1fr", gap: isMobile ? 8 : 10, marginBottom: 16 }}>
            <Stat label="Wage Range" value={`RM${selectedShift.wageMin}–${selectedShift.wageMax}`} sub="per hour" color={BRAND.text} />
            <Stat label="Shift Duration" value={`${selectedShift.hours}h`} sub={`${selectedShift.date}`} color={BRAND.text} />
            <Stat label="Estimated Gross" value={`RM${selectedShift.wageMax * selectedShift.hours}`} sub="at max rate" color={BRAND.green} />
            <Stat label="Travel Stipend" value={`RM${selectedShift.stipend}`} sub={selectedShift.travelTime} color={BRAND.blue} />
          </div>
          <Card style={{ marginBottom: 16 }}>
            <div style={{ fontSize: isMobile ? 12 : 13, fontWeight: 700, color: BRAND.text, marginBottom: 12 }}>Shift Details</div>
            {[
              ["📍 Location", selectedShift.location],
              ["🗓 Date", selectedShift.date],
              ["⏰ Time", selectedShift.time],
              ["👗 Dress Code", selectedShift.dress],
              ["👥 Headcount", `${selectedShift.headcount} workers needed`],
              ["🏢 Employer Score", `${selectedShift.reliabilityScore}/100`],
            ].map(([k, v]) => (
              <div key={k} style={{ display: "flex", gap: 8, marginBottom: 8 }}>
                <span style={{ fontSize: 13, color: BRAND.textMuted, width: 130, flexShrink: 0 }}>{k}</span>
                <span style={{ fontSize: 13, color: BRAND.text, fontWeight: 500 }}>{v}</span>
              </div>
            ))}
          </Card>
          <Card style={{ marginBottom: 20, background: BRAND.grayLight, border: "none" }}>
            <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 8, color: BRAND.text }}>Employer Reliability</div>
            <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 8 }}>
              <div style={{ flex: 1 }}><Progress value={selectedShift.reliabilityScore} color={selectedShift.reliabilityScore > 90 ? BRAND.green : selectedShift.reliabilityScore > 75 ? BRAND.accent : BRAND.red} /></div>
              <span style={{ fontWeight: 700, fontSize: 14, color: BRAND.text }}>{selectedShift.reliabilityScore}/100</span>
            </div>
            <div style={{ display: "flex", gap: 16 }}>
              <StarRating value={selectedShift.rating} />
              <span style={{ fontSize: 12, color: BRAND.textMuted }}>{selectedShift.totalApplicants} applicants</span>
            </div>
          </Card>
          <Btn onClick={() => setShowBidModal(true)} style={{ width: "100%", justifyContent: "center", fontSize: isMobile ? 14 : 16, padding: isMobile ? "12px 0" : "14px 0" }}>
            Place Bid →
          </Btn>
        </div>
      </div>
    </div>
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", width: "100%" }}>
      {/* Content */}
      <div style={{ flex: 1, overflowY: "auto", padding: tab === "discover" ? 0 : isMobile ? 12 : 20, width: "100%" }}>
        {tab === "discover" && (
          <div>
            <div style={{ padding: isMobile ? "12px 12px 0" : "20px 20px 0", background: `linear-gradient(160deg, ${BRAND.primary}15, transparent)` }}>
              <div style={{ fontSize: isMobile ? 18 : 22, fontWeight: 800, color: BRAND.text, marginBottom: 2 }}>Selamat Datang 👋</div>
              <div style={{ fontSize: isMobile ? 12 : 14, color: BRAND.textMuted, marginBottom: 12 }}>Find shifts near you — bid your rate</div>
              <div style={{ display: "flex", gap: 8, overflowX: "auto", paddingBottom: 12, scrollbarWidth: "none" }}>
                {cats.map(c => (
                  <button key={c} onClick={() => setFilterCat(c)} style={{
                    padding: isMobile ? "6px 12px" : "8px 16px", borderRadius: 99, border: "none", cursor: "pointer", fontFamily: "inherit",
                    fontWeight: 600, fontSize: isMobile ? 12 : 13, whiteSpace: "nowrap",
                    background: filterCat === c ? BRAND.primary : BRAND.grayLight,
                    color: filterCat === c ? "#fff" : BRAND.textMuted,
                    transition: "all 0.15s",
                  }}>{c}</button>
                ))}
              </div>
            </div>
            <div style={{ padding: isMobile ? "8px 12px 12px" : "8px 20px 20px", display: "flex", flexDirection: "column", gap: 12 }}>
              {filtered.map(s => (
                <Card key={s.id} onClick={() => setSelectedShift(s)} hover style={{ padding: 0, overflow: "hidden" }}>
                  <div style={{ padding: "12px 12px 0" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 6, gap: 8 }}>
                      <div style={{ flex: 1 }}>
                        <div style={{ display: "flex", gap: 4, marginBottom: 6, flexWrap: "wrap" }}>
                          <Badge color="amber" size="xs">{s.category}</Badge>
                          <Badge color="green" size="xs">Positions {s.headcount}</Badge>
                          <Badge color="blue" size="xs">Applied {s.totalApplicants}</Badge>
                        </div>
                        <div style={{ fontWeight: 700, fontSize: isMobile ? 13 : 15, color: BRAND.text, lineHeight: 1.3, marginBottom: 2 }}>{s.title}</div>
                        <div style={{ fontSize: isMobile ? 11 : 12, color: BRAND.textMuted }}>{s.employer}</div>
                      </div>
                      <div style={{ textAlign: "right", flexShrink: 0, marginLeft: 8 }}>
                        <div style={{ fontWeight: 800, fontSize: isMobile ? 15 : 18, color: BRAND.primary }}>RM{s.wageMin}–{s.wageMax}</div>
                        <div style={{ fontSize: isMobile ? 10 : 11, color: BRAND.textMuted }}>/hour</div>
                      </div>
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 0, borderTop: `1px solid ${BRAND.border}`, marginTop: 10 }}>
                    {[
                      [s.date, "📅"],
                      [s.location, "📍"],
                      [s.travelTime, "🚌"],
                      [`RM${s.stipend} stipend`, "💰"],
                    ].map(([v, ico], i) => (
                      <div key={i} style={{ flex: 1, padding: isMobile ? "6px 0" : "8px 0", textAlign: "center", borderRight: i < 3 ? `1px solid ${BRAND.border}` : "none" }}>
                        <div style={{ fontSize: isMobile ? 11 : 13 }}>{ico}</div>
                        <div style={{ fontSize: isMobile ? 9 : 10, color: BRAND.textMuted, marginTop: 1, lineHeight: 1.3 }}>{v}</div>
                      </div>
                    ))}
                  </div>
                </Card>
              ))}
            </div>
          </div>
        )}

        {tab === "applications" && (
          <div>
            <div style={{ fontSize: isMobile ? 18 : 20, fontWeight: 800, color: BRAND.text, marginBottom: 4 }}>My Bids</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {APPLICATIONS.map(a => (
                <Card key={a.id}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12 }}>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: 700, fontSize: 14, color: BRAND.text, marginBottom: 2 }}>{a.shiftTitle}</div>
                      <div style={{ fontSize: 12, color: BRAND.textMuted }}>{a.employer} · {a.date}</div>
                    </div>
                    <Pill label={a.status === "shortlisted" ? "Shortlisted" : a.status === "accepted" ? "Accepted" : "Pending"} color={a.status === "shortlisted" ? "amber" : a.status === "accepted" ? "green" : "gray"} />
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <div>
                      <span style={{ fontSize: 13, color: BRAND.textMuted }}>Your bid: </span>
                      <span style={{ fontSize: 15, fontWeight: 700, color: BRAND.text }}>RM{a.wageBid}/h</span>
                    </div>
                    {a.status === "shortlisted" && (
                      <Btn size="sm" onClick={() => setShowChat(true)}>Chat →</Btn>
                    )}
                    {a.status === "accepted" && (
                      <Btn size="sm" variant="success" onClick={() => setShowQR(true)}>Check In</Btn>
                    )}
                  </div>
                  {a.status === "shortlisted" && (
                    <div style={{ marginTop: 12, padding: "8px 12px", background: BRAND.amberLight, borderRadius: 8, fontSize: 12, color: BRAND.amber }}>
                      🎉 You've been shortlisted! Open chat to discuss and receive your offer.
                    </div>
                  )}
                </Card>
              ))}
            </div>
          </div>
        )}

        {tab === "earnings" && (
          <div>
            <div style={{ fontSize: isMobile ? 18 : 20, fontWeight: 800, color: BRAND.text, marginBottom: 4 }}>Earnings</div>
            <div style={{ fontSize: isMobile ? 12 : 13, color: BRAND.textMuted, marginBottom: 16 }}>Payouts & travel credits</div>
            <div style={{ background: `linear-gradient(135deg, ${BRAND.primary}, #C0280A)`, borderRadius: 20, padding: isMobile ? 18 : 24, marginBottom: 20, color: "#fff" }}>
              <div style={{ fontSize: isMobile ? 11 : 12, opacity: 0.8, marginBottom: 8 }}>Total Earned (June 2025)</div>
              <div style={{ fontSize: isMobile ? 32 : 38, fontWeight: 900, marginBottom: 4 }}>RM 842</div>
              <div style={{ fontSize: isMobile ? 12 : 13, opacity: 0.8 }}>+ RM 45 travel credits</div>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr 1fr" : "1fr 1fr", gap: 10, marginBottom: 20 }}>
              <Stat label="Shifts completed" value="12" color={BRAND.primary} />
              <Stat label="Avg hourly rate" value="RM15.20" color={BRAND.green} />
              <Stat label="Reliability score" value="94" sub="Excellent" color={BRAND.blue} />
              <Stat label="Travel credits" value="RM45" sub="unused" color={BRAND.accent} />
            </div>
            <div style={{ fontSize: isMobile ? 13 : 15, fontWeight: 700, color: BRAND.text, marginBottom: 12 }}>Recent Payouts</div>
            {[
              { shift: "Event Crew – Music Festival", amount: 200, date: "10 Jun", status: "completed", travel: 10 },
              { shift: "F&B Server – KLCC", amount: 85, date: "5 Jun", status: "completed", travel: 5 },
              { shift: "Retail Promoter – Pavilion", amount: 120, date: "28 May", status: "completed", travel: 0 },
            ].map((p, i) => (
              <Card key={i} style={{ marginBottom: 10, padding: "14px 16px" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <div>
                    <div style={{ fontWeight: 600, fontSize: 13, color: BRAND.text }}>{p.shift}</div>
                    <div style={{ fontSize: 12, color: BRAND.textMuted, marginTop: 2 }}>{p.date} · {p.travel > 0 ? `+RM${p.travel} travel` : "no travel credit"}</div>
                  </div>
                  <div style={{ textAlign: "right" }}>
                    <div style={{ fontWeight: 800, fontSize: 16, color: BRAND.green }}>+RM{p.amount}</div>
                    <Pill label="Paid" color="green" />
                  </div>
                </div>
              </Card>
            ))}
          </div>
        )}

        {tab === "profile" && (
          <div>
            <div style={{ textAlign: "center", padding: isMobile ? "12px 0 16px" : "20px 0 24px" }}>
              <Avatar name="Ahmad Firdaus" size={isMobile ? 56 : 72} color={BRAND.primary} />
              <div style={{ fontSize: isMobile ? 18 : 20, fontWeight: 800, color: BRAND.text, marginTop: isMobile ? 8 : 12 }}>Ahmad Firdaus</div>
              <div style={{ fontSize: isMobile ? 12 : 14, color: BRAND.textMuted }}>+60 12-345 6789</div>
              <div style={{ display: "flex", gap: 6, justifyContent: "center", marginTop: 8, flexWrap: "wrap" }}>
                <Badge color="teal">Standard KYC</Badge>
                <Badge color="green">94/100 Reliability</Badge>
              </div>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr 1fr" : "1fr 1fr", gap: 10, marginBottom: 20 }}>
              <Stat label="Shifts done" value="38" color={BRAND.primary} />
              <Stat label="Rating" value="4.7★" color={BRAND.accent} />
              <Stat label="Strikes" value="0" sub="Clean record" color={BRAND.green} />
              <Stat label="On-time rate" value="96%" color={BRAND.blue} />
            </div>
            <Card style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: BRAND.text, marginBottom: 12 }}>KYC Verification</div>
              {[{ tier: "Basic (Phone/Email)", status: "verified" }, { tier: "Standard (MyKad + Selfie)", status: "verified" }, { tier: "Advanced (Certifications)", status: "not started" }].map((v, i) => (
                <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 0", borderBottom: i < 2 ? `1px solid ${BRAND.border}` : "none" }}>
                  <span style={{ fontSize: 13, color: BRAND.text }}>{v.tier}</span>
                  <Pill label={v.status === "verified" ? "✓ Verified" : "—"} color={v.status === "verified" ? "green" : "gray"} />
                </div>
              ))}
            </Card>
            <Card style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: BRAND.text, marginBottom: 4 }}>Reliability Score: 94</div>
              <Progress value={94} color={BRAND.green} />
              <div style={{ fontSize: 12, color: BRAND.textMuted, marginTop: 8 }}>Excellent — you're in the top 15% of workers on CariGaji</div>
            </Card>
            <Card>
              <div style={{ fontSize: 14, fontWeight: 700, color: BRAND.text, marginBottom: 12 }}>Recent Ratings</div>
              {[{ from: "Grand Hyatt KL", stars: 5, note: "Excellent service, very professional", date: "10 Jun" }, { from: "Live Nation MY", stars: 4, note: "Reliable and hardworking", date: "28 May" }].map((r, i) => (
                <div key={i} style={{ marginBottom: 12 }}>
                  <div style={{ display: "flex", justifyContent: "space-between" }}>
                    <span style={{ fontSize: 13, fontWeight: 600, color: BRAND.text }}>{r.from}</span>
                    <span style={{ fontSize: 12, color: BRAND.textMuted }}>{r.date}</span>
                  </div>
                  <StarRating value={r.stars} size={13} />
                  <div style={{ fontSize: 12, color: BRAND.textMuted, marginTop: 4 }}>{r.note}</div>
                </div>
              ))}
            </Card>
          </div>
        )}

        {tab === "settings" && (
          <div>
            <div style={{ fontSize: isMobile ? 18 : 20, fontWeight: 800, color: BRAND.text, marginBottom: 4 }}>Settings</div>
            <div style={{ fontSize: isMobile ? 12 : 13, color: BRAND.textMuted, marginBottom: 16 }}>Manage your account and access hidden consoles</div>
            <Card style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: BRAND.text, marginBottom: 12 }}>Account</div>
              <div style={{ display: "flex", justifyContent: "space-between", padding: "8px 0", borderBottom: `1px solid ${BRAND.border}` }}>
                <span style={{ fontSize: 13, color: BRAND.textMuted }}>Language</span>
                <span style={{ fontSize: 13, fontWeight: 600, color: BRAND.text }}>English / Bahasa Melayu</span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", padding: "8px 0", borderBottom: `1px solid ${BRAND.border}` }}>
                <span style={{ fontSize: 13, color: BRAND.textMuted }}>Notifications</span>
                <span style={{ fontSize: 13, fontWeight: 600, color: BRAND.text }}>Enabled</span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", padding: "8px 0" }}>
                <span style={{ fontSize: 13, color: BRAND.textMuted }}>Privacy</span>
                <span style={{ fontSize: 13, fontWeight: 600, color: BRAND.text }}>Standard worker mode</span>
              </div>
            </Card>
            <Card style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: BRAND.text, marginBottom: 8 }}>Access other consoles</div>
              <div style={{ fontSize: 12, color: BRAND.textMuted, marginBottom: 14 }}>These are hidden from the main app and can only be opened here.</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                <Btn variant="secondary" onClick={() => onOpenPortal?.("employer")}>Open Employer Console</Btn>
                <Btn variant="secondary" onClick={() => onOpenPortal?.("admin")}>Open Admin Dashboard</Btn>
              </div>
            </Card>
          </div>
        )}
      </div>

      {/* Bottom nav */}
      <div style={{ borderTop: `1px solid ${BRAND.border}`, background: "#fff", display: "flex", flexShrink: 0, minHeight: isMobile ? 60 : 72 }}>
        {navItems.map(n => (
          <button key={n.id} onClick={() => setTab(n.id)} style={{
            flex: 1, padding: isMobile ? "6px 0" : "10px 0", border: "none", background: "none", cursor: "pointer",
            display: "flex", flexDirection: "column", alignItems: "center", gap: isMobile ? 2 : 3,
            color: tab === n.id ? BRAND.primary : BRAND.textMuted,
            fontFamily: "inherit",
          }}>
            <span style={{ fontSize: isMobile ? 16 : 20, lineHeight: 1 }}>{n.icon}</span>
            <span style={{ fontSize: isMobile ? 9 : 10, fontWeight: tab === n.id ? 700 : 400, whiteSpace: "nowrap" }}>{n.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
};

// ─── EMPLOYER PORTAL ─────────────────────────────────────────────────────────
const EmployerPortal = ({ onOpenPortal, compact = false }) => {
  const [view, setView] = useState("dashboard");
  const [selectedShift, setSelectedShift] = useState(null);
  const [postStep, setPostStep] = useState(1);
  const [form, setForm] = useState({ title: "", category: "F&B", date: "", timeStart: "", timeEnd: "", wageMin: "", wageMax: "", headcount: 1, dress: "", location: "KLCC, KL City Centre" });
  const [applicantAction, setApplicantAction] = useState({});

  const navItems = ["Dashboard", "Shifts", "Post Shift", "Billing", "Account"];

  const handleApplicantAction = (id, action) => {
    setApplicantAction(prev => ({ ...prev, [id]: action }));
  };

  const shiftApplicants = selectedShift ? EMPLOYER_APPLICANTS : [];

  return (
    <div style={{ display: "flex", flexDirection: compact ? "column" : "row", height: "100%", fontFamily: "inherit" }}>
      {/* Sidebar */}
      <div style={{ width: compact ? "100%" : 180, borderRight: compact ? "none" : `1px solid ${BRAND.border}`, borderBottom: compact ? `1px solid ${BRAND.border}` : "none", padding: "24px 0", background: "#fff", flexShrink: 0, display: "flex", flexDirection: "column" }}>
        <div style={{ padding: "0 20px 24px" }}>
          <div style={{ fontWeight: 900, fontSize: 20, color: BRAND.primary }}>CariGaji</div>
          <div style={{ fontSize: 11, color: BRAND.textMuted, fontWeight: 500 }}>Employer Console</div>
        </div>
        {navItems.map(n => (
          <button key={n} onClick={() => { setView(n.toLowerCase().replace(" ", "")); setSelectedShift(null); setPostStep(1); }}
            style={{
              display: "block", width: "100%", textAlign: "left", padding: "10px 20px",
              background: view === n.toLowerCase().replace(" ", "") ? BRAND.primaryLight : "none",
              color: view === n.toLowerCase().replace(" ", "") ? BRAND.primary : BRAND.textMuted,
              border: "none", cursor: "pointer", fontFamily: "inherit", fontWeight: 600, fontSize: 13,
              borderLeft: view === n.toLowerCase().replace(" ", "") ? `3px solid ${BRAND.primary}` : "3px solid transparent",
              transition: "all 0.1s",
            }}>{n}</button>
        ))}
        <div style={{ padding: "24px 20px 0", marginTop: "auto" }}>
          <div style={{ fontSize: 12, color: BRAND.textMuted, marginBottom: 6 }}>Escrow Balance</div>
          <div style={{ fontWeight: 800, fontSize: 18, color: BRAND.green }}>RM 2,840</div>
          <Btn size="xs" variant="ghost" style={{ marginTop: 8, width: "100%", justifyContent: "center" }}>Top Up</Btn>
          <Btn size="xs" variant="secondary" onClick={() => onOpenPortal?.("worker")} style={{ marginTop: 8, width: "100%", justifyContent: "center" }}>Return to Worker App</Btn>
        </div>
      </div>

      {/* Main */}
      <div style={{ flex: 1, overflowY: "auto", padding: compact ? 16 : 28, background: BRAND.grayLight }}>

        {view === "dashboard" && (
          <div>
            <div style={{ fontSize: 22, fontWeight: 800, color: BRAND.text, marginBottom: 4 }}>Dashboard</div>
            <div style={{ fontSize: 14, color: BRAND.textMuted, marginBottom: 24 }}>Good morning, Grand Hyatt KL</div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12, marginBottom: 24 }}>
              <Stat label="Active shifts" value="2" color={BRAND.primary} />
              <Stat label="Total applicants" value="23" color={BRAND.blue} />
              <Stat label="Filled slots" value="9/17" color={BRAND.green} />
              <Stat label="Reliability score" value="94" sub="/100" color={BRAND.accent} />
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 16 }}>
              <div>
                <div style={{ fontWeight: 700, fontSize: 16, color: BRAND.text, marginBottom: 12 }}>Active Shifts</div>
                {EMPLOYER_SHIFTS.filter(s => s.status !== "draft").map(s => (
                  <Card key={s.id} onClick={() => { setSelectedShift(s); setView("shifts"); }} hover style={{ marginBottom: 12 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                      <div>
                        <div style={{ fontWeight: 700, fontSize: 14, color: BRAND.text, marginBottom: 4 }}>{s.title}</div>
                        <div style={{ fontSize: 12, color: BRAND.textMuted }}>{s.date} · {s.time}</div>
                      </div>
                      <Pill label={s.status} color={s.status === "open" ? "blue" : s.status === "completed" ? "green" : "gray"} />
                    </div>
                    <div style={{ marginTop: 12 }}>
                      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 6 }}>
                        <Badge color="green" size="xs">Positions {s.headcount}</Badge>
                        <Badge color="blue" size="xs">Applied {s.applicants}</Badge>
                      </div>
                      <Progress value={s.filled} max={s.headcount} color={BRAND.green} />
                    </div>
                  </Card>
                ))}
              </div>
              <div>
                <div style={{ fontWeight: 700, fontSize: 16, color: BRAND.text, marginBottom: 12 }}>Quick Actions</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  <Btn onClick={() => { setView("postshift"); setPostStep(1); }} style={{ justifyContent: "center" }}>+ Post New Shift</Btn>
                  <Card style={{ padding: 14 }}>
                    <div style={{ fontSize: 12, fontWeight: 600, color: BRAND.text, marginBottom: 8 }}>Recent Activity</div>
                    {["Ahmad Firdaus bid RM14/h for Wedding Banquet", "Nurul Ain shortlisted for Wedding Banquet", "Shift 'Kitchen Helper' completed"].map((a, i) => (
                      <div key={i} style={{ fontSize: 12, color: BRAND.textMuted, padding: "4px 0", borderBottom: i < 2 ? `1px solid ${BRAND.border}` : "none" }}>{a}</div>
                    ))}
                  </Card>
                </div>
              </div>
            </div>
          </div>
        )}

        {view === "shifts" && !selectedShift && (
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 24 }}>
              <div>
                <div style={{ fontSize: 22, fontWeight: 800, color: BRAND.text }}>My Shifts</div>
                <div style={{ fontSize: 14, color: BRAND.textMuted }}>Manage all your posted shifts</div>
              </div>
              <Btn onClick={() => { setView("postshift"); setPostStep(1); }}>+ Post Shift</Btn>
            </div>
            {EMPLOYER_SHIFTS.map(s => (
              <Card key={s.id} onClick={() => setSelectedShift(s)} hover style={{ marginBottom: 12 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 6 }}>
                      <span style={{ fontWeight: 700, fontSize: 15, color: BRAND.text }}>{s.title}</span>
                      <Pill label={s.status} color={s.status === "open" ? "blue" : s.status === "completed" ? "green" : "gray"} />
                    </div>
                    <div style={{ fontSize: 12, color: BRAND.textMuted }}>{s.date} · {s.time}</div>
                  </div>
                  <div style={{ textAlign: "right" }}>
                    <div style={{ fontWeight: 700, fontSize: 14, color: BRAND.green }}>RM{s.escrow} escrow</div>
                        <div style={{ display: "flex", gap: 6, justifyContent: "flex-end", flexWrap: "wrap", marginTop: 6 }}>
                          <Badge color="green" size="xs">Positions {s.headcount}</Badge>
                          <Badge color="blue" size="xs">Applied {s.applicants}</Badge>
                        </div>
                  </div>
                </div>
                    <div style={{ marginTop: 12, display: "flex", gap: 16, flexWrap: "wrap" }}>
                      <span style={{ fontSize: 12, color: BRAND.textMuted }}>Positions needed: {s.headcount}</span>
                      <span style={{ fontSize: 12, color: BRAND.textMuted }}>Filled: {s.filled}</span>
                      <span style={{ fontSize: 12, color: BRAND.textMuted }}>Category: {s.category}</span>
                </div>
              </Card>
            ))}
          </div>
        )}

        {view === "shifts" && selectedShift && (
          <div>
            <button onClick={() => setSelectedShift(null)} style={{ background: "none", border: "none", cursor: "pointer", fontSize: 14, color: BRAND.primary, fontFamily: "inherit", marginBottom: 16 }}>← Back to shifts</button>
            <div style={{ fontSize: 22, fontWeight: 800, color: BRAND.text, marginBottom: 4 }}>{selectedShift.title}</div>
            <div style={{ display: "flex", gap: 8, marginBottom: 20 }}>
              <Pill label={selectedShift.status} color={selectedShift.status === "open" ? "blue" : selectedShift.status === "completed" ? "green" : "gray"} />
              <span style={{ fontSize: 14, color: BRAND.textMuted }}>{selectedShift.date}</span>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10, marginBottom: 24 }}>
              <Stat label="Applied users" value={selectedShift.applicants} color={BRAND.blue} />
              <Stat label="Slots filled" value={`${selectedShift.filled}/${selectedShift.headcount}`} color={BRAND.green} />
              <Stat label="Escrow" value={`RM${selectedShift.escrow}`} color={BRAND.primary} />
              <Stat label="Avg bid" value="RM14.40" color={BRAND.accent} />
            </div>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 12 }}>
              <div>
                <div style={{ fontWeight: 700, fontSize: 16, color: BRAND.text, marginBottom: 4 }}>Applicant pool</div>
                <div style={{ fontSize: 13, color: BRAND.textMuted }}>Choose from all applied users, even when applications exceed the number of needed workers.</div>
              </div>
              <Badge color="blue">{selectedShift.applicants} applied</Badge>
            </div>
            <table style={{ width: "100%", borderCollapse: "collapse", background: "#fff", borderRadius: 16, overflow: "hidden", border: `1px solid ${BRAND.border}` }}>
              <thead>
                <tr style={{ background: BRAND.grayLight }}>
                  {["Worker", "KYC", "Reliability", "Rating", "Bid (RM/h)", "Status", "Action"].map(h => (
                    <th key={h} style={{ padding: "12px 14px", fontSize: 11, fontWeight: 700, color: BRAND.textMuted, textAlign: "left", borderBottom: `1px solid ${BRAND.border}` }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {shiftApplicants.map(a => {
                  const action = applicantAction[a.id] || a.status;
                  return (
                    <tr key={a.id} style={{ borderBottom: `1px solid ${BRAND.border}` }}>
                      <td style={{ padding: "12px 14px" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          <Avatar name={a.name} size={28} color={BRAND.blue} />
                          <div>
                            <div style={{ fontSize: 13, fontWeight: 600, color: BRAND.text }}>{a.name}</div>
                            <div style={{ fontSize: 11, color: BRAND.textMuted }}>{a.completedShifts} shifts done</div>
                          </div>
                        </div>
                      </td>
                      <td style={{ padding: "12px 14px" }}><Badge color={a.kyc === "Advanced" ? "teal" : a.kyc === "Standard" ? "blue" : "gray"} size="xs">{a.kyc}</Badge></td>
                      <td style={{ padding: "12px 14px" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                          <Progress value={a.reliability} color={a.reliability > 90 ? BRAND.green : a.reliability > 75 ? BRAND.accent : BRAND.red} />
                          <span style={{ fontSize: 12, color: BRAND.text, minWidth: 28 }}>{a.reliability}</span>
                        </div>
                      </td>
                      <td style={{ padding: "12px 14px" }}><StarRating value={a.rating} size={11} /></td>
                      <td style={{ padding: "12px 14px", fontWeight: 700, color: BRAND.primary, fontSize: 14 }}>RM{a.wageBid}</td>
                      <td style={{ padding: "12px 14px" }}><Pill label={action} color={action === "accepted" ? "green" : action === "shortlisted" ? "amber" : action === "rejected" ? "red" : "gray"} /></td>
                      <td style={{ padding: "12px 14px" }}>
                        {action !== "accepted" && action !== "rejected" && (
                          <div style={{ display: "flex", gap: 6 }}>
                            {action !== "shortlisted" && <Btn size="xs" variant="secondary" onClick={() => handleApplicantAction(a.id, "shortlisted")}>Shortlist</Btn>}
                            <Btn size="xs" variant="success" onClick={() => handleApplicantAction(a.id, "accepted")}>Accept</Btn>
                            <Btn size="xs" variant="danger" onClick={() => handleApplicantAction(a.id, "rejected")}>Reject</Btn>
                          </div>
                        )}
                        {action === "accepted" && <span style={{ fontSize: 12, color: BRAND.green }}>✓ Hired</span>}
                        {action === "rejected" && <span style={{ fontSize: 12, color: BRAND.red }}>✗ Rejected</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {view === "postshift" && (
          <div style={{ maxWidth: 600 }}>
            <div style={{ fontSize: 22, fontWeight: 800, color: BRAND.text, marginBottom: 4 }}>Post a Shift</div>
            <div style={{ fontSize: 14, color: BRAND.textMuted, marginBottom: 24 }}>Fill in shift details and required workers</div>
            <div style={{ display: "flex", gap: 8, marginBottom: 28 }}>
              {[1, 2, 3].map(s => (
                <div key={s} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <div style={{ width: 28, height: 28, borderRadius: "50%", background: postStep >= s ? BRAND.primary : BRAND.border, color: postStep >= s ? "#fff" : BRAND.textMuted, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, fontWeight: 700 }}>{s}</div>
                  <span style={{ fontSize: 12, color: postStep >= s ? BRAND.text : BRAND.textMuted, fontWeight: postStep === s ? 700 : 400 }}>{["Shift Details", "Requirements", "Review & Post"][s - 1]}</span>
                  {s < 3 && <span style={{ color: BRAND.border, fontSize: 18 }}>→</span>}
                </div>
              ))}
            </div>

            <Card>
              {postStep === 1 && (
                <div>
                  <Input label="Shift title" placeholder="e.g. F&B Server – Corporate Dinner" value={form.title} onChange={e => setForm(f => ({ ...f, title: e.target.value }))} />
                  <Select label="Category" value={form.category} onChange={e => setForm(f => ({ ...f, category: e.target.value }))} options={["F&B", "Retail", "Event", "Logistics", "Other"].map(v => ({ value: v, label: v }))} />
                  <Input label="Location" value={form.location} onChange={e => setForm(f => ({ ...f, location: e.target.value }))} />
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                    <Input label="Date" type="date" value={form.date} onChange={e => setForm(f => ({ ...f, date: e.target.value }))} />
                    <Input label="Headcount" type="number" value={form.headcount} onChange={e => setForm(f => ({ ...f, headcount: e.target.value }))} />
                    <Input label="Start time" type="time" value={form.timeStart} onChange={e => setForm(f => ({ ...f, timeStart: e.target.value }))} />
                    <Input label="End time" type="time" value={form.timeEnd} onChange={e => setForm(f => ({ ...f, timeEnd: e.target.value }))} />
                  </div>
                  <div style={{ marginBottom: 16 }}>
                    <label style={{ display: "block", fontSize: 13, fontWeight: 600, color: BRAND.text, marginBottom: 6 }}>Wage Range (RM/hour)</label>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                      <Input placeholder="Min e.g. 12" type="number" value={form.wageMin} onChange={e => setForm(f => ({ ...f, wageMin: e.target.value }))} />
                      <Input placeholder="Max e.g. 16" type="number" value={form.wageMax} onChange={e => setForm(f => ({ ...f, wageMax: e.target.value }))} />
                    </div>
                    {form.wageMin && form.wageMax && (
                      <div style={{ background: BRAND.primaryLight, borderRadius: 8, padding: "8px 12px", fontSize: 12, color: BRAND.primary }}>
                        Workers can bid up to RM{(parseFloat(form.wageMax || 0) * 1.5).toFixed(0)}/h (150% of max)
                      </div>
                    )}
                  </div>
                  <Btn onClick={() => setPostStep(2)} style={{ width: "100%", justifyContent: "center" }}>Next: Requirements →</Btn>
                </div>
              )}
              {postStep === 2 && (
                <div>
                  <Input label="Dress code" placeholder="e.g. All black formal" value={form.dress} onChange={e => setForm(f => ({ ...f, dress: e.target.value }))} />
                  <div style={{ marginBottom: 16 }}>
                    <label style={{ display: "block", fontSize: 13, fontWeight: 600, color: BRAND.text, marginBottom: 8 }}>Required documents</label>
                    {["IC / Passport", "Food Handler Certificate", "First Aid Certification", "Driving License"].map(doc => (
                      <label key={doc} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8, cursor: "pointer", fontSize: 13, color: BRAND.text }}>
                        <input type="checkbox" /> {doc}
                      </label>
                    ))}
                  </div>
                  <div style={{ marginBottom: 16 }}>
                    <label style={{ display: "block", fontSize: 13, fontWeight: 600, color: BRAND.text, marginBottom: 6 }}>Special requirements</label>
                    <textarea placeholder="Any additional requirements…" style={{ width: "100%", padding: "10px 14px", borderRadius: 10, border: `1px solid ${BRAND.border}`, fontSize: 13, fontFamily: "inherit", height: 80, resize: "none", boxSizing: "border-box" }} />
                  </div>
                  <div style={{ display: "flex", gap: 10 }}>
                    <Btn variant="secondary" onClick={() => setPostStep(1)} style={{ flex: 1, justifyContent: "center" }}>← Back</Btn>
                    <Btn onClick={() => setPostStep(3)} style={{ flex: 1, justifyContent: "center" }}>Next: Review →</Btn>
                  </div>
                </div>
              )}
              {postStep === 3 && (
                <div>
                  <div style={{ fontWeight: 700, fontSize: 15, color: BRAND.text, marginBottom: 16 }}>Review your shift</div>
                  {[
                    ["Title", form.title || "(not set)"],
                    ["Category", form.category],
                    ["Location", form.location],
                    ["Date", form.date || "(not set)"],
                    ["Headcount", form.headcount],
                    ["Wage range", form.wageMin && form.wageMax ? `RM${form.wageMin}–RM${form.wageMax}/h` : "(not set)"],
                    ["Dress code", form.dress || "None"],
                  ].map(([k, v]) => (
                    <div key={k} style={{ display: "flex", justifyContent: "space-between", padding: "8px 0", borderBottom: `1px solid ${BRAND.border}`, fontSize: 13 }}>
                      <span style={{ color: BRAND.textMuted }}>{k}</span>
                      <span style={{ fontWeight: 600, color: BRAND.text }}>{v}</span>
                    </div>
                  ))}
                  {form.wageMax && form.headcount && (
                    <div style={{ background: BRAND.amberLight, borderRadius: 10, padding: "12px 16px", marginTop: 16, marginBottom: 16 }}>
                      <div style={{ fontSize: 12, color: BRAND.amber, fontWeight: 600, marginBottom: 4 }}>Estimated escrow required</div>
                      <div style={{ fontSize: 22, fontWeight: 800, color: BRAND.amber }}>RM{(parseFloat(form.wageMax || 0) * parseInt(form.headcount || 0) * 8).toFixed(0)}</div>
                      <div style={{ fontSize: 11, color: BRAND.amber }}>wage_max × headcount × 8h (estimated) + 15% platform fee</div>
                    </div>
                  )}
                  <div style={{ display: "flex", gap: 10, marginTop: 8 }}>
                    <Btn variant="secondary" onClick={() => setPostStep(2)} style={{ flex: 1, justifyContent: "center" }}>← Back</Btn>
                    <Btn onClick={() => { alert("✅ Shift published! Workers will start applying within minutes."); setView("shifts"); setPostStep(1); }} style={{ flex: 1, justifyContent: "center" }}>Publish Shift 🚀</Btn>
                  </div>
                </div>
              )}
            </Card>
          </div>
        )}

        {view === "billing" && (
          <div>
            <div style={{ fontSize: 22, fontWeight: 800, color: BRAND.text, marginBottom: 24 }}>Billing & Escrow</div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12, marginBottom: 24 }}>
              <Stat label="Escrow balance" value="RM 2,840" color={BRAND.green} />
              <Stat label="Locked (active shifts)" value="RM 640" color={BRAND.amber} />
              <Stat label="Total paid out" value="RM 4,210" color={BRAND.primary} />
            </div>
            <Btn style={{ marginBottom: 24 }}>+ Top Up Escrow</Btn>
            <div style={{ fontWeight: 700, fontSize: 16, color: BRAND.text, marginBottom: 12 }}>Escrow Ledger</div>
            <Card style={{ padding: 0, overflow: "hidden" }}>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr style={{ background: BRAND.grayLight }}>
                    {["Date", "Type", "Shift", "Amount", "Balance"].map(h => (
                      <th key={h} style={{ padding: "12px 16px", fontSize: 11, fontWeight: 700, color: BRAND.textMuted, textAlign: "left", borderBottom: `1px solid ${BRAND.border}` }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {[
                    { date: "12 Jun", type: "funded", shift: "Wedding Banquet", amount: "+640", balance: "2,840" },
                    { date: "10 Jun", type: "released", shift: "Kitchen Helper", amount: "−180", balance: "2,200" },
                    { date: "10 Jun", type: "fee", shift: "Kitchen Helper", amount: "−27", balance: "2,380" },
                    { date: "8 Jun", type: "funded", shift: "Kitchen Helper", amount: "+207", balance: "2,407" },
                  ].map((row, i) => (
                    <tr key={i} style={{ borderBottom: `1px solid ${BRAND.border}` }}>
                      <td style={{ padding: "12px 16px", fontSize: 13, color: BRAND.textMuted }}>{row.date}</td>
                      <td style={{ padding: "12px 16px" }}><Badge color={row.type === "funded" ? "blue" : row.type === "released" ? "red" : row.type === "fee" ? "amber" : "gray"} size="xs">{row.type}</Badge></td>
                      <td style={{ padding: "12px 16px", fontSize: 13, color: BRAND.text }}>{row.shift}</td>
                      <td style={{ padding: "12px 16px", fontSize: 13, fontWeight: 700, color: row.amount.startsWith("+") ? BRAND.green : BRAND.red }}>{row.amount}</td>
                      <td style={{ padding: "12px 16px", fontSize: 13, fontWeight: 600, color: BRAND.text }}>RM {row.balance}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          </div>
        )}

        {view === "account" && (
          <div style={{ maxWidth: 500 }}>
            <div style={{ fontSize: 22, fontWeight: 800, color: BRAND.text, marginBottom: 24 }}>Account & Verification</div>
            <Card style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: BRAND.text, marginBottom: 12 }}>Company Details</div>
              <Input label="Company name" value="Grand Hyatt Kuala Lumpur" onChange={() => {}} />
              <Input label="SSM registration number" value="1234567-A" onChange={() => {}} />
              <Input label="Contact email" value="hr@grandhyatt-kl.com" onChange={() => {}} />
            </Card>
            <Card style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: BRAND.text, marginBottom: 12 }}>Verification Status</div>
              {[{ label: "SSM Document", status: "approved" }, { label: "Bank Account (DuitNow)", status: "approved" }, { label: "Escrow Deposit", status: "approved" }].map((v, i) => (
                <div key={i} style={{ display: "flex", justifyContent: "space-between", padding: "8px 0", borderBottom: i < 2 ? `1px solid ${BRAND.border}` : "none" }}>
                  <span style={{ fontSize: 13, color: BRAND.text }}>{v.label}</span>
                  <Pill label="✓ Approved" color="green" />
                </div>
              ))}
            </Card>
            <Btn style={{ width: "100%", justifyContent: "center" }}>Save Changes</Btn>
          </div>
        )}
      </div>
    </div>
  );
};

// ─── ADMIN PORTAL ─────────────────────────────────────────────────────────────
const AdminPortal = ({ onOpenPortal, compact = false }) => {
  const [view, setView] = useState("overview");
  const [kycActions, setKycActions] = useState({});
  const [disputeActions, setDisputeActions] = useState({});
  const [flagActions, setFlagActions] = useState({});

  const navItems = ["Overview", "KYC Queue", "Disputes", "Flags", "Payouts", "Config"];

  const FLAGS = [
    { id: 1, user: "Wei Jian Lim", type: "GPS mismatch", riskScore: 87, shift: "Warehouse Packer – Shah Alam", time: "3 hours ago", status: "open" },
    { id: 2, user: "Unknown Device #42", type: "QR token reuse", riskScore: 95, shift: "Event Crew – Music Festival", time: "5 hours ago", status: "open" },
    { id: 3, user: "Muhammad Izzat", type: "No-show (confirmed)", riskScore: 72, shift: "F&B Server – Wedding Banquet", time: "1 day ago", status: "open" },
  ];

  return (
    <div style={{ display: "flex", flexDirection: compact ? "column" : "row", height: "100%" }}>
      {/* Sidebar */}
      <div style={{ width: compact ? "100%" : 190, borderRight: compact ? "none" : `1px solid ${BRAND.border}`, borderBottom: compact ? `1px solid ${BRAND.border}` : "none", padding: "24px 0", background: BRAND.dark, flexShrink: 0, display: "flex", flexDirection: "column" }}>
        <div style={{ padding: "0 20px 28px" }}>
          <div style={{ fontWeight: 900, fontSize: 20, color: BRAND.primary }}>CariGaji</div>
          <div style={{ fontSize: 11, color: "rgba(255,255,255,0.4)", fontWeight: 500 }}>Admin Dashboard</div>
        </div>
        {navItems.map(n => {
          const key = n.toLowerCase().replace(" ", "");
          return (
            <button key={n} onClick={() => setView(key)} style={{
              display: "block", width: "100%", textAlign: "left", padding: "10px 20px",
              background: view === key ? "rgba(232,56,13,0.15)" : "none",
              color: view === key ? BRAND.primary : "rgba(255,255,255,0.55)",
              border: "none", cursor: "pointer", fontFamily: "inherit", fontWeight: 600, fontSize: 13,
              borderLeft: view === key ? `3px solid ${BRAND.primary}` : "3px solid transparent",
            }}>{n}</button>
          );
        })}
        <div style={{ padding: "24px 20px 0", marginTop: 16, borderTop: "1px solid rgba(255,255,255,0.1)" }}>
          <div style={{ fontSize: 11, color: "rgba(255,255,255,0.35)", marginBottom: 8 }}>Logged in as</div>
          <div style={{ fontSize: 13, color: "rgba(255,255,255,0.8)", fontWeight: 600 }}>Rafiq Ismail</div>
          <div style={{ fontSize: 11, color: "rgba(255,255,255,0.4)" }}>Superadmin</div>
          <Btn size="xs" variant="ghost" onClick={() => onOpenPortal?.("worker")} style={{ marginTop: 10, width: "100%", justifyContent: "center", borderColor: "rgba(255,255,255,0.2)", color: "#fff" }}>Return to Worker App</Btn>
        </div>
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflowY: "auto", padding: compact ? 16 : 28, background: BRAND.grayLight }}>

        {view === "overview" && (
          <div>
            <div style={{ fontSize: 22, fontWeight: 800, color: BRAND.text, marginBottom: 4 }}>Platform Overview</div>
            <div style={{ fontSize: 14, color: BRAND.textMuted, marginBottom: 24 }}>Klang Valley — Live metrics</div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12, marginBottom: 24 }}>
              <Stat label="Open shifts" value="18" color={BRAND.blue} />
              <Stat label="Pending KYC" value={ADMIN_KYC.filter(k => k.status === "pending").length} color={BRAND.amber} />
              <Stat label="Open disputes" value={ADMIN_DISPUTES.filter(d => d.status === "open" || d.status === "under_review").length} color={BRAND.red} />
              <Stat label="Fill rate" value="84%" color={BRAND.green} />
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12, marginBottom: 24 }}>
              <Stat label="Active workers" value="423" color={BRAND.primary} />
              <Stat label="Registered employers" value="67" color={BRAND.primary} />
              <Stat label="Shifts today" value="12" color={BRAND.primary} />
              <Stat label="Payout queue" value="RM 8,420" color={BRAND.green} />
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
              <Card>
                <div style={{ fontWeight: 700, fontSize: 14, color: BRAND.text, marginBottom: 12 }}>KYC Queue</div>
                {ADMIN_KYC.slice(0, 3).map(k => (
                  <div key={k.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 0", borderBottom: `1px solid ${BRAND.border}` }}>
                    <div style={{ fontSize: 13, color: BRAND.text }}>{k.name}</div>
                    <Badge color={k.status === "flagged" ? "red" : "amber"} size="xs">{k.status}</Badge>
                  </div>
                ))}
                <Btn size="xs" variant="secondary" onClick={() => setView("kycqueue")} style={{ marginTop: 10 }}>View all →</Btn>
              </Card>
              <Card>
                <div style={{ fontWeight: 700, fontSize: 14, color: BRAND.text, marginBottom: 12 }}>Active Disputes</div>
                {ADMIN_DISPUTES.slice(0, 3).map(d => (
                  <div key={d.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 0", borderBottom: `1px solid ${BRAND.border}` }}>
                    <div style={{ fontSize: 13, color: BRAND.text }}>{d.id} – {d.reason}</div>
                    <Badge color={d.status === "escalated" ? "red" : d.status === "under_review" ? "amber" : "blue"} size="xs">{d.status}</Badge>
                  </div>
                ))}
                <Btn size="xs" variant="secondary" onClick={() => setView("disputes")} style={{ marginTop: 10 }}>View all →</Btn>
              </Card>
            </div>
          </div>
        )}

        {view === "kycqueue" && (
          <div>
            <div style={{ fontSize: 22, fontWeight: 800, color: BRAND.text, marginBottom: 4 }}>KYC Review Queue</div>
            <div style={{ fontSize: 14, color: BRAND.textMuted, marginBottom: 24 }}>{ADMIN_KYC.length} pending reviews</div>
            {ADMIN_KYC.map(k => {
              const action = kycActions[k.id];
              return (
                <Card key={k.id} style={{ marginBottom: 14 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12 }}>
                    <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                      <Avatar name={k.name} size={40} color={BRAND.blue} />
                      <div>
                        <div style={{ fontWeight: 700, fontSize: 15, color: BRAND.text }}>{k.name}</div>
                        <div style={{ fontSize: 12, color: BRAND.textMuted }}>{k.type} KYC · Submitted {k.submitted}</div>
                      </div>
                    </div>
                    <div style={{ display: "flex", gap: 6 }}>
                      <Badge color={k.status === "flagged" ? "red" : "amber"}>{k.status}</Badge>
                      <Badge color="blue">{k.type}</Badge>
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 8, marginBottom: 14, flexWrap: "wrap" }}>
                    {k.docs.map(doc => (
                      <div key={doc} style={{ background: BRAND.grayLight, border: `1px solid ${BRAND.border}`, borderRadius: 8, padding: "6px 12px", fontSize: 12, color: BRAND.text, cursor: "pointer" }}
                        onClick={() => alert(`[Simulated] Viewing: ${doc}`)}>
                        📄 {doc}
                      </div>
                    ))}
                  </div>
                  {action ? (
                    <div style={{ padding: "8px 12px", borderRadius: 8, background: action === "approved" ? BRAND.greenLight : BRAND.redLight, fontSize: 13, fontWeight: 600, color: action === "approved" ? "#065F46" : "#991B1B" }}>
                      {action === "approved" ? "✓ Approved" : "✗ Rejected"} — action logged
                    </div>
                  ) : (
                    <div style={{ display: "flex", gap: 10 }}>
                      <Btn size="sm" variant="success" onClick={() => setKycActions(prev => ({ ...prev, [k.id]: "approved" }))}>✓ Approve</Btn>
                      <Btn size="sm" variant="danger" onClick={() => setKycActions(prev => ({ ...prev, [k.id]: "rejected" }))}>✗ Reject</Btn>
                      <Btn size="sm" variant="secondary" onClick={() => alert("Re-upload request sent to user")}>Request Re-upload</Btn>
                    </div>
                  )}
                </Card>
              );
            })}
          </div>
        )}

        {view === "disputes" && (
          <div>
            <div style={{ fontSize: 22, fontWeight: 800, color: BRAND.text, marginBottom: 4 }}>Disputes Dashboard</div>
            <div style={{ fontSize: 14, color: BRAND.textMuted, marginBottom: 24 }}>{ADMIN_DISPUTES.length} disputes total</div>
            {ADMIN_DISPUTES.map(d => {
              const action = disputeActions[d.id];
              return (
                <Card key={d.id} style={{ marginBottom: 14 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12 }}>
                    <div>
                      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 4 }}>
                        <span style={{ fontWeight: 800, fontSize: 14, color: BRAND.text }}>{d.id}</span>
                        <Badge color={d.status === "escalated" ? "red" : d.status === "under_review" ? "amber" : "blue"}>{d.status}</Badge>
                      </div>
                      <div style={{ fontSize: 13, color: BRAND.textMuted }}>Opened {d.opened}</div>
                    </div>
                    <div style={{ fontWeight: 700, fontSize: 16, color: BRAND.primary }}>RM{d.amount}</div>
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10, marginBottom: 12 }}>
                    <div><div style={{ fontSize: 11, color: BRAND.textMuted }}>Worker</div><div style={{ fontSize: 13, fontWeight: 600, color: BRAND.text }}>{d.worker}</div></div>
                    <div><div style={{ fontSize: 11, color: BRAND.textMuted }}>Employer</div><div style={{ fontSize: 13, fontWeight: 600, color: BRAND.text }}>{d.employer}</div></div>
                    <div><div style={{ fontSize: 11, color: BRAND.textMuted }}>Reason</div><div style={{ fontSize: 13, fontWeight: 600, color: BRAND.text }}>{d.reason}</div></div>
                  </div>
                  <div style={{ fontSize: 13, color: BRAND.textMuted, marginBottom: 4 }}>Shift: {d.shift}</div>
                  <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
                    <button onClick={() => alert(`[Simulated] Viewing check-in/out logs, chat history and GPS data for ${d.id}`)} style={{ fontSize: 12, color: BRAND.blue, background: "none", border: "none", cursor: "pointer", fontFamily: "inherit", textDecoration: "underline" }}>View evidence →</button>
                  </div>
                  {action ? (
                    <div style={{ padding: "8px 12px", borderRadius: 8, background: BRAND.greenLight, fontSize: 13, fontWeight: 600, color: "#065F46" }}>
                      ✓ Resolved — payout {action}
                    </div>
                  ) : (
                    <div style={{ display: "flex", gap: 8 }}>
                      <Btn size="sm" variant="success" onClick={() => setDisputeActions(prev => ({ ...prev, [d.id]: "released to worker" }))}>Release to Worker</Btn>
                      <Btn size="sm" variant="danger" onClick={() => setDisputeActions(prev => ({ ...prev, [d.id]: "refunded to employer" }))}>Refund Employer</Btn>
                      <Btn size="sm" variant="secondary" onClick={() => setDisputeActions(prev => ({ ...prev, [d.id]: "split 50/50" }))}>Split 50/50</Btn>
                    </div>
                  )}
                </Card>
              );
            })}
          </div>
        )}

        {view === "flags" && (
          <div>
            <div style={{ fontSize: 22, fontWeight: 800, color: BRAND.text, marginBottom: 4 }}>Fraud & No-Show Flags</div>
            <div style={{ fontSize: 14, color: BRAND.textMuted, marginBottom: 24 }}>{FLAGS.length} active flags requiring review</div>
            {FLAGS.map(f => {
              const action = flagActions[f.id];
              return (
                <Card key={f.id} style={{ marginBottom: 14 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12 }}>
                    <div>
                      <div style={{ fontWeight: 700, fontSize: 15, color: BRAND.text, marginBottom: 4 }}>{f.user}</div>
                      <div style={{ display: "flex", gap: 8 }}>
                        <Badge color={f.type === "QR token reuse" ? "red" : f.type === "GPS mismatch" ? "amber" : "orange"}>{f.type}</Badge>
                        <Badge color={f.riskScore > 90 ? "red" : f.riskScore > 75 ? "amber" : "gray"}>Risk: {f.riskScore}/100</Badge>
                      </div>
                    </div>
                    <div style={{ fontSize: 12, color: BRAND.textMuted }}>{f.time}</div>
                  </div>
                  <div style={{ fontSize: 13, color: BRAND.textMuted, marginBottom: 14 }}>Shift: {f.shift}</div>
                  {action ? (
                    <div style={{ padding: "8px 12px", borderRadius: 8, background: action === "suspended" ? BRAND.redLight : BRAND.amberLight, fontSize: 13, fontWeight: 600, color: action === "suspended" ? "#991B1B" : "#92400E" }}>
                      Action: {action} — logged to audit trail
                    </div>
                  ) : (
                    <div style={{ display: "flex", gap: 8 }}>
                      <Btn size="sm" variant="danger" onClick={() => setFlagActions(prev => ({ ...prev, [f.id]: "suspended" }))}>Suspend Account</Btn>
                      <Btn size="sm" variant="secondary" onClick={() => setFlagActions(prev => ({ ...prev, [f.id]: "warning issued" }))}>Issue Warning</Btn>
                      <Btn size="sm" variant="secondary" onClick={() => setFlagActions(prev => ({ ...prev, [f.id]: "dismissed" }))}>Dismiss</Btn>
                    </div>
                  )}
                </Card>
              );
            })}
          </div>
        )}

        {view === "payouts" && (
          <div>
            <div style={{ fontSize: 22, fontWeight: 800, color: BRAND.text, marginBottom: 24 }}>Payout Overrides</div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12, marginBottom: 24 }}>
              <Stat label="Pending payouts" value="RM 8,420" color={BRAND.amber} />
              <Stat label="Disputed (held)" value="RM 308" color={BRAND.red} />
              <Stat label="Paid this month" value="RM 24,110" color={BRAND.green} />
            </div>
            <Card>
              <div style={{ fontWeight: 700, fontSize: 14, color: BRAND.text, marginBottom: 16 }}>Payout Queue</div>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr style={{ background: BRAND.grayLight }}>
                    {["Worker", "Shift", "Amount", "Scheduled", "Status", "Action"].map(h => (
                      <th key={h} style={{ padding: "10px 12px", fontSize: 11, fontWeight: 700, color: BRAND.textMuted, textAlign: "left", borderBottom: `1px solid ${BRAND.border}` }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {[
                    { worker: "Ahmad Firdaus", shift: "Event Crew", amount: 200, scheduled: "14 Jun", status: "processing" },
                    { worker: "Nurul Ain", shift: "Retail Promoter", amount: 128, scheduled: "15 Jun", status: "pending" },
                    { worker: "Hafiz Roslan", shift: "F&B Server", amount: 70, scheduled: "16 Jun", status: "disputed" },
                    { worker: "Priya Selvam", shift: "Warehouse Packer", amount: 88, scheduled: "16 Jun", status: "pending" },
                  ].map((p, i) => (
                    <tr key={i} style={{ borderBottom: `1px solid ${BRAND.border}` }}>
                      <td style={{ padding: "10px 12px", fontSize: 13, fontWeight: 600, color: BRAND.text }}>{p.worker}</td>
                      <td style={{ padding: "10px 12px", fontSize: 13, color: BRAND.textMuted }}>{p.shift}</td>
                      <td style={{ padding: "10px 12px", fontSize: 13, fontWeight: 700, color: BRAND.green }}>RM{p.amount}</td>
                      <td style={{ padding: "10px 12px", fontSize: 13, color: BRAND.textMuted }}>{p.scheduled}</td>
                      <td style={{ padding: "10px 12px" }}><Pill label={p.status} color={p.status === "processing" ? "blue" : p.status === "disputed" ? "red" : "gray"} /></td>
                      <td style={{ padding: "10px 12px" }}>
                        <div style={{ display: "flex", gap: 6 }}>
                          <Btn size="xs" variant="success" onClick={() => alert(`Released RM${p.amount} to ${p.worker}`)}>Release</Btn>
                          <Btn size="xs" variant="secondary" onClick={() => alert(`RM${p.amount} payout held for ${p.worker}`)}>Hold</Btn>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          </div>
        )}

        {view === "config" && (
          <div style={{ maxWidth: 520 }}>
            <div style={{ fontSize: 22, fontWeight: 800, color: BRAND.text, marginBottom: 4 }}>Platform Configuration</div>
            <div style={{ fontSize: 14, color: BRAND.textMuted, marginBottom: 24 }}>Global rules — changes apply immediately</div>
            <Card style={{ marginBottom: 16 }}>
              <div style={{ fontWeight: 700, fontSize: 14, color: BRAND.text, marginBottom: 14 }}>Bid rules</div>
              <Input label="Max bid multiplier (% of employer wage_max)" type="number" value="150" onChange={() => {}} />
              <Input label="Minimum wage floor (RM/hour)" type="number" value="5" onChange={() => {}} />
            </Card>
            <Card style={{ marginBottom: 16 }}>
              <div style={{ fontWeight: 700, fontSize: 14, color: BRAND.text, marginBottom: 14 }}>Cancellation windows</div>
              <Input label="Employer cancellation fee threshold (hours before shift)" type="number" value="24" onChange={() => {}} />
              <Input label="Worker late-cancel threshold (hours before shift)" type="number" value="4" onChange={() => {}} />
            </Card>
            <Card style={{ marginBottom: 16 }}>
              <div style={{ fontWeight: 700, fontSize: 14, color: BRAND.text, marginBottom: 14 }}>Travel stipend bands (RM)</div>
              {[["0–5 km", "0"], ["5–15 km", "5"], ["15–30 km", "10"], ["30–50 km", "18"], [">50 km", "25"]].map(([band, val]) => (
                <div key={band} style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 10 }}>
                  <span style={{ fontSize: 13, color: BRAND.text, minWidth: 80 }}>{band}</span>
                  <input type="number" defaultValue={val} style={{ width: 80, padding: "6px 10px", borderRadius: 8, border: `1px solid ${BRAND.border}`, fontSize: 13, fontFamily: "inherit" }} />
                  <span style={{ fontSize: 12, color: BRAND.textMuted }}>RM</span>
                </div>
              ))}
            </Card>
            <Card style={{ marginBottom: 16 }}>
              <div style={{ fontWeight: 700, fontSize: 14, color: BRAND.text, marginBottom: 14 }}>Platform fee</div>
              <Input label="Platform fee (% of gross shift cost)" type="number" value="15" onChange={() => {}} />
            </Card>
            <Btn onClick={() => alert("✅ Configuration saved and applied globally")} style={{ width: "100%", justifyContent: "center" }}>Save Configuration</Btn>
          </div>
        )}
      </div>
    </div>
  );
};

// ─── ROOT APP ─────────────────────────────────────────────────────────────────
export default function CariGaji() {
  const [portal, setPortal] = useState("worker");
  const [viewport, setViewport] = useState({ width: typeof window !== "undefined" ? window.innerWidth : 0, height: typeof window !== "undefined" ? window.innerHeight : 0 });

  useEffect(() => {
    const handleResize = () => {
      setViewport({ width: window.innerWidth, height: window.innerHeight });
    };

    handleResize();
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  const isMobile = viewport.width < 768;

  const portalConfig = {
    worker: { label: "Worker", color: BRAND.primary, width: 390, height: 780 },
    employer: { label: "Employer", color: BRAND.blue, width: 960, height: 640 },
    admin: { label: "Admin", color: BRAND.accent, width: 960, height: 640 },
  };
  const cfg = portalConfig[portal];

  return (
    <div style={{
      minHeight: "100vh",
      background: isMobile
        ? `linear-gradient(180deg, ${BRAND.primary}08 0%, #fff 18%, #fff 100%)`
        : `radial-gradient(circle at top, ${BRAND.primary}20 0%, #140806 42%, ${BRAND.dark} 100%)`,
      display: "flex",
      alignItems: isMobile ? "stretch" : "center",
      justifyContent: "center",
      padding: isMobile ? 0 : 24,
      fontFamily: "'DM Sans', system-ui, sans-serif",
    }}>
      <div style={{
        width: isMobile ? "100%" : Math.min(portal === "worker" ? 1240 : cfg.width, viewport.width - 48),
        height: isMobile ? "100vh" : Math.min(cfg.height + 120, viewport.height - 48),
        background: isMobile ? "#fff" : "rgba(255,255,255,0.98)",
        borderRadius: isMobile ? 0 : 28,
        overflow: "hidden",
        border: isMobile ? "none" : `1px solid rgba(255,255,255,0.14)`,
        boxShadow: isMobile ? "none" : "0 40px 90px rgba(0,0,0,0.45)",
        position: "relative",
        display: "flex",
        flexDirection: "column",
      }}>
        <div style={{
          height: isMobile ? 56 : 68,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: isMobile ? "0 16px" : "0 24px",
          borderBottom: `1px solid ${BRAND.border}`,
          background: "rgba(255,255,255,0.92)",
          backdropFilter: "blur(16px)",
          flexShrink: 0,
        }}>
          <div>
            <div style={{ fontSize: isMobile ? 18 : 22, fontWeight: 900, color: BRAND.text, letterSpacing: "-0.03em" }}>
              Cari<span style={{ color: BRAND.primary }}>Gaji</span>
            </div>
            <div style={{ fontSize: isMobile ? 10 : 12, color: BRAND.textMuted }}>Verified shift marketplace</div>
          </div>
          {!isMobile && (
            <Badge color={portal === "worker" ? "green" : portal === "employer" ? "blue" : "amber"}>
              {cfg.label}
            </Badge>
          )}
        </div>
        <div style={{ flex: 1, overflow: "hidden", display: "flex", flexDirection: "column" }}>
          {portal === "worker" && <WorkerPortal onOpenPortal={setPortal} isMobile={isMobile} />}
          {portal === "employer" && <EmployerPortal onOpenPortal={setPortal} compact={isMobile} />}
          {portal === "admin" && <AdminPortal onOpenPortal={setPortal} compact={isMobile} />}
        </div>
      </div>
    </div>
  );
}