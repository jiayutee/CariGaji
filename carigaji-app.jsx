import { useState, useEffect, useRef } from "react";
import { supabase } from "./src/lib/supabase.js";

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

const Btn = ({ children, variant = "primary", onClick, size = "md", style = {}, disabled = false, type = "button" }) => {
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
    <button type={type} onClick={disabled ? undefined : onClick} style={{ ...base, ...variants[variant], ...style }}
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

const PasswordInput = ({ label, placeholder, value, onChange, style = {}, hideToggle = false }) => {
  const [show, setShow] = useState(false);
  return (
    <div style={{ marginBottom: 16, position: "relative", ...style }}>
      {label && <label style={{ display: "block", fontSize: 13, fontWeight: 600, color: BRAND.text, marginBottom: 6 }}>{label}</label>}
      <div style={{ position: "relative" }}>
        <input
          type={show ? "text" : "password"}
          placeholder={placeholder}
          value={value}
          onChange={onChange}
          style={{
            width: "100%", padding: "10px 14px", borderRadius: 10,
            border: `1px solid ${BRAND.border}`, fontSize: 14, fontFamily: "inherit",
            color: BRAND.text, background: "#fff", outline: "none",
            boxSizing: "border-box", height: 42, lineHeight: "20px",
          }}
        />
        {!hideToggle && (
          <button type="button" onClick={() => setShow(s => !s)} aria-label={show ? "Hide password" : "Show password"} style={{ position: "absolute", right: 8, top: 6, border: "none", background: "transparent", cursor: "pointer", width: 28, height: 28, display: "flex", alignItems: "center", justifyContent: "center", padding: 0 }}>
            {show ? (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M3 3L21 21" stroke="#374151" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                <path d="M10.58 10.58A3 3 0 0 0 13.42 13.42" stroke="#374151" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                <path d="M2.05 12.6A11 11 0 0 0 12 20c2.1 0 4.09-.5 5.95-1.4" stroke="#374151" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            ) : (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z" stroke="#374151" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                <circle cx="12" cy="12" r="3" stroke="#374151" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            )}
          </button>
        )}
      </div>
    </div>
  );
};

const FileInput = ({ label, onChange, accept, helper, fileName }) => (
  <div style={{ marginBottom: 16 }}>
    {label && <label style={{ display: "block", fontSize: 13, fontWeight: 600, color: BRAND.text, marginBottom: 6 }}>{label}</label>}
    <input
      type="file"
      accept={accept}
      onChange={onChange}
      style={{
        width: "100%",
        padding: "10px 14px",
        borderRadius: 10,
        border: `1px solid ${BRAND.border}`,
        fontSize: 14,
        fontFamily: "inherit",
        color: BRAND.text,
        background: "#fff",
        outline: "none",
        boxSizing: "border-box",
      }}
    />
    {(fileName || helper) && (
      <div style={{ fontSize: 12, color: BRAND.textMuted, marginTop: 6, lineHeight: 1.5 }}>
        {fileName ? `Selected: ${fileName}` : helper}
      </div>
    )}
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
      <span key={i} style={{ color: i <= Math.round(value) ? BRAND.accent : "#D1D5DB", fontSize: size }}>
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style={{ display: "inline-block", verticalAlign: "middle" }}>
          <path d="M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z" fill={i <= Math.round(value) ? BRAND.accent : "#D1D5DB"} />
        </svg>
      </span>
    );
  }
  return <span>{stars} <span style={{ fontSize: size - 2, color: BRAND.textMuted }}>({value})</span></span>;
};

const Icons = {
  Search: ({ size = 18 }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M21 21l-4.35-4.35" stroke="#374151" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="11" cy="11" r="6" stroke="#374151" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  List: ({ size = 18 }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" stroke="#374151" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  Money: ({ size = 18 }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect x="2" y="6" width="20" height="12" rx="2" stroke="#374151" strokeWidth="1.6" />
      <circle cx="12" cy="12" r="3" stroke="#374151" strokeWidth="1.6" />
    </svg>
  ),
  User: ({ size = 18 }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" stroke="#374151" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="12" cy="7" r="4" stroke="#374151" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  Settings: ({ size = 18 }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M12 15.5A3.5 3.5 0 1 0 12 8.5a3.5 3.5 0 0 0 0 7z" stroke="#374151" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06A2 2 0 1 1 2.3 17.88l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82L4.21 3.7A2 2 0 1 1 7 1.88l.06.06a1.65 1.65 0 0 0 1.82.33h.09A1.65 1.65 0 0 0 10 1.88V1a2 2 0 1 1 4 0v.09c.36.12.69.32 1 .56.33.27.66.52.96.82l.06.06a2 2 0 1 1 2.83 2.83l-.06-.06a1.65 1.65 0 0 0-.33 1.82v.09c.12.36.32.69.56 1 .27.33.52.66.82.96l.06.06A2 2 0 1 1 19.4 15z" stroke="#374151" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  Close: ({ size = 18 }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M18 6L6 18M6 6l12 12" stroke="#374151" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  Camera: ({ size = 48 }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h3l2-3h6l2 3h3a2 2 0 0 1 2 2v11z" stroke="#374151" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="12" cy="13" r="4" stroke="#374151" strokeWidth="1.4" />
    </svg>
  ),
  ArrowLeft: ({ size = 18 }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M19 12H5" stroke="#374151" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M12 19l-7-7 7-7" stroke="#374151" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  ChevronDown: ({ size = 14 }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M6 9l6 6 6-6" stroke="#374151" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  Rocket: ({ size = 16 }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M12 2s4 1 6 3 3 6 3 6-4 1-6 3-6 6-6 6-4-4-6-6 6-6 6-6 1-4 3-6z" stroke="#374151" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  Star: ({ size = 14 }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z" fill="#F5A623" />
    </svg>
  ),
};

const Progress = ({ value, max = 100, color = BRAND.primary }) => (
  <div style={{ height: 6, background: "#F3F4F6", borderRadius: 99, overflow: "hidden" }}>
    <div style={{ height: "100%", width: `${(value / max) * 100}%`, background: color, borderRadius: 99, transition: "width 0.3s" }} />
  </div>
);

const formatIdentityNumber = (value, identityType) => {
  if (identityType === "MyKad") {
    const digits = value.replace(/\D/g, "").slice(0, 12);
    if (digits.length <= 6) return digits;
    if (digits.length <= 8) return `${digits.slice(0, 6)}-${digits.slice(6)}`;
    return `${digits.slice(0, 6)}-${digits.slice(6, 8)}-${digits.slice(8)}`;
  }
  return value;
};

const extractDateFromIC = (icNumber) => {
  const digits = icNumber.replace(/\D/g, "");
  if (digits.length < 6) return "";
  const yy = parseInt(digits.slice(0, 2), 10);
  const mm = digits.slice(2, 4);
  const dd = digits.slice(4, 6);
  const year = yy > 50 ? 1900 + yy : 2000 + yy;
  return `${year}-${mm}-${dd}`;
};

const assignKYCLevel = (hasFront, hasBack, hasSelfie, hasSupportingDoc) => {
  if (!hasSelfie) return "Basic";
  if ((hasFront || hasBack) && hasSelfie) return "Standard";
  if (hasSupportingDoc && hasSelfie) return "Advanced";
  return "Basic";
};

const KYC_BUCKET = "kyc-documents";

const uploadKycFile = async (userId, file, label) => {
  if (!file) return null;
  const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
  const path = `${userId}/${Date.now()}-${label}-${safeName}`;
  const { error } = await supabase.storage.from(KYC_BUCKET).upload(path, file, {
    contentType: file.type || "application/octet-stream",
    upsert: true,
  });
  if (error) throw error;
  return path;
};

  const COUNTRIES = [
    { code: "MY", name: "Malaysia", flag: "🇲🇾", dialCode: "+60", placeholder: "e.g. 10-1234567" },
    { code: "AF", name: "Afghanistan", flag: "🇦🇫", dialCode: "+93", placeholder: "e.g. 701-234-567" },
    { code: "AL", name: "Albania", flag: "🇦🇱", dialCode: "+355", placeholder: "e.g. 69-123-4567" },
    { code: "DZ", name: "Algeria", flag: "🇩🇿", dialCode: "+213", placeholder: "e.g. 21-123-4567" },
    { code: "AS", name: "American Samoa", flag: "🇦🇸", dialCode: "+1-684", placeholder: "e.g. 735-1234" },
    { code: "AD", name: "Andorra", flag: "🇦🇩", dialCode: "+376", placeholder: "e.g. 312-345" },
    { code: "AO", name: "Angola", flag: "🇦🇴", dialCode: "+244", placeholder: "e.g. 923-123-456" },
    { code: "AR", name: "Argentina", flag: "🇦🇷", dialCode: "+54", placeholder: "e.g. 11-1234-5678" },
    { code: "AM", name: "Armenia", flag: "🇦🇲", dialCode: "+374", placeholder: "e.g. 10-123-456" },
    { code: "AW", name: "Aruba", flag: "🇦🇼", dialCode: "+297", placeholder: "e.g. 567-1234" },
    { code: "AU", name: "Australia", flag: "🇦🇺", dialCode: "+61", placeholder: "e.g. 2-1234-5678" },
    { code: "AT", name: "Austria", flag: "🇦🇹", dialCode: "+43", placeholder: "e.g. 1-234-5678" },
    { code: "AZ", name: "Azerbaijan", flag: "🇦🇿", dialCode: "+994", placeholder: "e.g. 12-345-6789" },
    { code: "BS", name: "Bahamas", flag: "🇧🇸", dialCode: "+1-242", placeholder: "e.g. 327-1234" },
    { code: "BH", name: "Bahrain", flag: "🇧🇭", dialCode: "+973", placeholder: "e.g. 36-123-456" },
    { code: "BD", name: "Bangladesh", flag: "🇧🇩", dialCode: "+880", placeholder: "e.g. 171-123-4567" },
    { code: "BB", name: "Barbados", flag: "🇧🇧", dialCode: "+1-246", placeholder: "e.g. 430-1234" },
    { code: "BY", name: "Belarus", flag: "🇧🇾", dialCode: "+375", placeholder: "e.g. 17-123-4567" },
    { code: "BE", name: "Belgium", flag: "🇧🇪", dialCode: "+32", placeholder: "e.g. 2-123-4567" },
    { code: "BZ", name: "Belize", flag: "🇧🇿", dialCode: "+501", placeholder: "e.g. 2-123-456" },
    { code: "BJ", name: "Benin", flag: "🇧🇯", dialCode: "+229", placeholder: "e.g. 90-123-456" },
    { code: "BT", name: "Bhutan", flag: "🇧🇹", dialCode: "+975", placeholder: "e.g. 17-123-456" },
    { code: "BO", name: "Bolivia", flag: "🇧🇴", dialCode: "+591", placeholder: "e.g. 2-123-4567" },
    { code: "BA", name: "Bosnia and Herzegovina", flag: "🇧🇦", dialCode: "+387", placeholder: "e.g. 33-123-456" },
    { code: "BW", name: "Botswana", flag: "🇧🇼", dialCode: "+267", placeholder: "e.g. 71-123-4567" },
    { code: "BR", name: "Brazil", flag: "🇧🇷", dialCode: "+55", placeholder: "e.g. 11-91234-5678" },
    { code: "BN", name: "Brunei", flag: "🇧🇳", dialCode: "+673", placeholder: "e.g. 712-3456" },
    { code: "BG", name: "Bulgaria", flag: "🇧🇬", dialCode: "+359", placeholder: "e.g. 2-123-4567" },
    { code: "BF", name: "Burkina Faso", flag: "🇧🇫", dialCode: "+226", placeholder: "e.g. 70-123-456" },
    { code: "BI", name: "Burundi", flag: "🇧🇮", dialCode: "+257", placeholder: "e.g. 79-123-456" },
    { code: "KH", name: "Cambodia", flag: "🇰🇭", dialCode: "+855", placeholder: "e.g. 12-345-678" },
    { code: "CM", name: "Cameroon", flag: "🇨🇲", dialCode: "+237", placeholder: "e.g. 6-123-4567" },
    { code: "CA", name: "Canada", flag: "🇨🇦", dialCode: "+1", placeholder: "e.g. 555-123-4567" },
    { code: "CV", name: "Cape Verde", flag: "🇨🇻", dialCode: "+238", placeholder: "e.g. 99-123-456" },
    { code: "KY", name: "Cayman Islands", flag: "🇰🇾", dialCode: "+1-345", placeholder: "e.g. 945-1234" },
    { code: "CF", name: "Central African Republic", flag: "🇨🇫", dialCode: "+236", placeholder: "e.g. 75-123-456" },
    { code: "TD", name: "Chad", flag: "🇹🇩", dialCode: "+235", placeholder: "e.g. 65-123-456" },
    { code: "CL", name: "Chile", flag: "🇨🇱", dialCode: "+56", placeholder: "e.g. 2-1234-5678" },
    { code: "CN", name: "China", flag: "🇨🇳", dialCode: "+86", placeholder: "e.g. 138-1234-5678" },
    { code: "CO", name: "Colombia", flag: "🇨🇴", dialCode: "+57", placeholder: "e.g. 1-234-5678" },
    { code: "KM", name: "Comoros", flag: "🇰🇲", dialCode: "+269", placeholder: "e.g. 321-23-45" },
    { code: "CG", name: "Congo", flag: "🇨🇬", dialCode: "+242", placeholder: "e.g. 06-123-456" },
    { code: "CD", name: "Congo (DRC)", flag: "🇨🇩", dialCode: "+243", placeholder: "e.g. 81-123-4567" },
    { code: "CR", name: "Costa Rica", flag: "🇨🇷", dialCode: "+506", placeholder: "e.g. 2222-2222" },
    { code: "CI", name: "Côte d'Ivoire", flag: "🇨🇮", dialCode: "+225", placeholder: "e.g. 01-23-45-67" },
    { code: "HR", name: "Croatia", flag: "🇭🇷", dialCode: "+385", placeholder: "e.g. 1-123-4567" },
    { code: "CU", name: "Cuba", flag: "🇨🇺", dialCode: "+53", placeholder: "e.g. 5-123-4567" },
    { code: "CY", name: "Cyprus", flag: "🇨🇾", dialCode: "+357", placeholder: "e.g. 22-123-456" },
    { code: "CZ", name: "Czech Republic", flag: "🇨🇿", dialCode: "+420", placeholder: "e.g. 602-123-456" },
    { code: "DK", name: "Denmark", flag: "🇩🇰", dialCode: "+45", placeholder: "e.g. 12-34-56-78" },
    { code: "DJ", name: "Djibouti", flag: "🇩🇯", dialCode: "+253", placeholder: "e.g. 77-12-34-56" },
    { code: "DM", name: "Dominica", flag: "🇩🇲", dialCode: "+1-767", placeholder: "e.g. 275-1234" },
    { code: "DO", name: "Dominican Republic", flag: "🇩🇴", dialCode: "+1-809", placeholder: "e.g. 829-123-4567" },
    { code: "EC", name: "Ecuador", flag: "🇪🇨", dialCode: "+593", placeholder: "e.g. 9-123-4567" },
    { code: "EG", name: "Egypt", flag: "🇪🇬", dialCode: "+20", placeholder: "e.g. 10-1234-5678" },
    { code: "SV", name: "El Salvador", flag: "🇸🇻", dialCode: "+503", placeholder: "e.g. 7777-7777" },
    { code: "GQ", name: "Equatorial Guinea", flag: "🇬🇶", dialCode: "+240", placeholder: "e.g. 222-123-456" },
    { code: "ER", name: "Eritrea", flag: "🇪🇷", dialCode: "+291", placeholder: "e.g. 7-123-456" },
    { code: "EE", name: "Estonia", flag: "🇪🇪", dialCode: "+372", placeholder: "e.g. 5123-4567" },
    { code: "ET", name: "Ethiopia", flag: "🇪🇹", dialCode: "+251", placeholder: "e.g. 911-23-456" },
    { code: "FJ", name: "Fiji", flag: "🇫🇯", dialCode: "+679", placeholder: "e.g. 701-1234" },
    { code: "FI", name: "Finland", flag: "🇫🇮", dialCode: "+358", placeholder: "e.g. 40-123-4567" },
    { code: "FR", name: "France", flag: "🇫🇷", dialCode: "+33", placeholder: "e.g. 06-12-34-56-78" },
    { code: "PF", name: "French Polynesia", flag: "🇵🇫", dialCode: "+689", placeholder: "e.g. 87-123-456" },
    { code: "GA", name: "Gabon", flag: "🇬🇦", dialCode: "+241", placeholder: "e.g. 06-12-34-56" },
    { code: "GM", name: "Gambia", flag: "🇬🇲", dialCode: "+220", placeholder: "e.g. 301-2345" },
    { code: "GE", name: "Georgia", flag: "🇬🇪", dialCode: "+995", placeholder: "e.g. 599-12-345" },
    { code: "DE", name: "Germany", flag: "🇩🇪", dialCode: "+49", placeholder: "e.g. 151-12345678" },
    { code: "GH", name: "Ghana", flag: "🇬🇭", dialCode: "+233", placeholder: "e.g. 24-123-4567" },
    { code: "GR", name: "Greece", flag: "🇬🇷", dialCode: "+30", placeholder: "e.g. 21-1234-5678" },
    { code: "GD", name: "Grenada", flag: "🇬🇩", dialCode: "+1-473", placeholder: "e.g. 440-1234" },
    { code: "GU", name: "Guam", flag: "🇬🇺", dialCode: "+1-671", placeholder: "e.g. 969-1234" },
    { code: "GT", name: "Guatemala", flag: "🇬🇹", dialCode: "+502", placeholder: "e.g. 4-1234-5678" },
    { code: "GN", name: "Guinea", flag: "🇬🇳", dialCode: "+224", placeholder: "e.g. 30-123-456" },
    { code: "GW", name: "Guinea-Bissau", flag: "🇬🇼", dialCode: "+245", placeholder: "e.g. 95-123-456" },
    { code: "GY", name: "Guyana", flag: "🇬🇾", dialCode: "+592", placeholder: "e.g. 223-1234" },
    { code: "HT", name: "Haiti", flag: "🇭🇹", dialCode: "+509", placeholder: "e.g. 34-12-3456" },
    { code: "HN", name: "Honduras", flag: "🇭🇳", dialCode: "+504", placeholder: "e.g. 9-9123-4567" },
    { code: "HK", name: "Hong Kong", flag: "🇭🇰", dialCode: "+852", placeholder: "e.g. 1234-5678" },
    { code: "HU", name: "Hungary", flag: "🇭🇺", dialCode: "+36", placeholder: "e.g. 20-123-4567" },
    { code: "IS", name: "Iceland", flag: "🇮🇸", dialCode: "+354", placeholder: "e.g. 861-1234" },
    { code: "IR", name: "Iran", flag: "🇮🇷", dialCode: "+98", placeholder: "e.g. 912-123-4567" },
    { code: "IQ", name: "Iraq", flag: "🇮🇶", dialCode: "+964", placeholder: "e.g. 770-123-4567" },
    { code: "IE", name: "Ireland", flag: "🇮🇪", dialCode: "+353", placeholder: "e.g. 87-123-4567" },
    { code: "IL", name: "Israel", flag: "🇮🇱", dialCode: "+972", placeholder: "e.g. 50-123-4567" },
    { code: "IT", name: "Italy", flag: "🇮🇹", dialCode: "+39", placeholder: "e.g. 345-123-4567" },
    { code: "JM", name: "Jamaica", flag: "🇯🇲", dialCode: "+1-876", placeholder: "e.g. 876-123-4567" },
    { code: "JP", name: "Japan", flag: "🇯🇵", dialCode: "+81", placeholder: "e.g. 90-1234-5678" },
    { code: "JO", name: "Jordan", flag: "🇯🇴", dialCode: "+962", placeholder: "e.g. 79-123-4567" },
    { code: "KZ", name: "Kazakhstan", flag: "🇰🇿", dialCode: "+7", placeholder: "e.g. 701-123-4567" },
    { code: "KE", name: "Kenya", flag: "🇰🇪", dialCode: "+254", placeholder: "e.g. 71-123-4567" },
    { code: "KI", name: "Kiribati", flag: "🇰🇮", dialCode: "+686", placeholder: "e.g. 731-2345" },
    { code: "KP", name: "North Korea", flag: "🇰🇵", dialCode: "+850", placeholder: "e.g. 123-4567" },
    { code: "KR", name: "South Korea", flag: "🇰🇷", dialCode: "+82", placeholder: "e.g. 10-1234-5678" },
    { code: "KW", name: "Kuwait", flag: "🇰🇼", dialCode: "+965", placeholder: "e.g. 500-12345" },
    { code: "KG", name: "Kyrgyzstan", flag: "🇰🇬", dialCode: "+996", placeholder: "e.g. 555-123456" },
    { code: "LA", name: "Laos", flag: "🇱🇦", dialCode: "+856", placeholder: "e.g. 20-123-4567" },
    { code: "LV", name: "Latvia", flag: "🇱🇻", dialCode: "+371", placeholder: "e.g. 2-123-4567" },
    { code: "LB", name: "Lebanon", flag: "🇱🇧", dialCode: "+961", placeholder: "e.g. 71-123456" },
    { code: "LS", name: "Lesotho", flag: "🇱🇸", dialCode: "+266", placeholder: "e.g. 58-123-456" },
    { code: "LR", name: "Liberia", flag: "🇱🇷", dialCode: "+231", placeholder: "e.g. 077-123-456" },
    { code: "LY", name: "Libya", flag: "🇱🇾", dialCode: "+218", placeholder: "e.g. 91-123-4567" },
    { code: "LI", name: "Liechtenstein", flag: "🇱🇮", dialCode: "+423", placeholder: "e.g. 660-1234" },
    { code: "LT", name: "Lithuania", flag: "🇱🇹", dialCode: "+370", placeholder: "e.g. 612-34567" },
    { code: "LU", name: "Luxembourg", flag: "🇱🇺", dialCode: "+352", placeholder: "e.g. 621-123456" },
    { code: "MO", name: "Macau", flag: "🇲🇴", dialCode: "+853", placeholder: "e.g. 6-123-4567" },
    { code: "MK", name: "North Macedonia", flag: "🇲🇰", dialCode: "+389", placeholder: "e.g. 70-123-456" },
    { code: "MG", name: "Madagascar", flag: "🇲🇬", dialCode: "+261", placeholder: "e.g. 32-12-345-67" },
    { code: "MW", name: "Malawi", flag: "🇲🇼", dialCode: "+265", placeholder: "e.g. 88-123-4567" },
    { code: "MX", name: "Mexico", flag: "🇲🇽", dialCode: "+52", placeholder: "e.g. 55-1234-5678" },
    { code: "FM", name: "Micronesia", flag: "🇫🇲", dialCode: "+691", placeholder: "e.g. 350-1234" },
    { code: "MD", name: "Moldova", flag: "🇲🇩", dialCode: "+373", placeholder: "e.g. 79-123-456" },
    { code: "MC", name: "Monaco", flag: "🇲🇨", dialCode: "+377", placeholder: "e.g. 6-12-34-56" },
    { code: "MN", name: "Mongolia", flag: "🇲🇳", dialCode: "+976", placeholder: "e.g. 99-123-4567" },
    { code: "ME", name: "Montenegro", flag: "🇲🇪", dialCode: "+382", placeholder: "e.g. 67-123-456" },
    { code: "MA", name: "Morocco", flag: "🇲🇦", dialCode: "+212", placeholder: "e.g. 6-123-45678" },
    { code: "MZ", name: "Mozambique", flag: "🇲🇿", dialCode: "+258", placeholder: "e.g. 82-123-4567" },
    { code: "MM", name: "Myanmar", flag: "🇲🇲", dialCode: "+95", placeholder: "e.g. 9-123-45678" },
    { code: "NA", name: "Namibia", flag: "🇳🇦", dialCode: "+264", placeholder: "e.g. 81-123-4567" },
    { code: "NR", name: "Nauru", flag: "🇳🇷", dialCode: "+674", placeholder: "e.g. 555-1234" },
    { code: "NP", name: "Nepal", flag: "🇳🇵", dialCode: "+977", placeholder: "e.g. 98-123-4567" },
    { code: "NL", name: "Netherlands", flag: "🇳🇱", dialCode: "+31", placeholder: "e.g. 6-1234-5678" },
    { code: "NI", name: "Nicaragua", flag: "🇳🇮", dialCode: "+505", placeholder: "e.g. 8-1234-5678" },
    { code: "NE", name: "Niger", flag: "🇳🇪", dialCode: "+227", placeholder: "e.g. 90-123-456" },
    { code: "NG", name: "Nigeria", flag: "🇳🇬", dialCode: "+234", placeholder: "e.g. 812-123-4567" },
    { code: "NO", name: "Norway", flag: "🇳🇴", dialCode: "+47", placeholder: "e.g. 912-34-567" },
    { code: "OM", name: "Oman", flag: "🇴🇲", dialCode: "+968", placeholder: "e.g. 9-123-4567" },
    { code: "PK", name: "Pakistan", flag: "🇵🇰", dialCode: "+92", placeholder: "e.g. 300-1234567" },
    { code: "PW", name: "Palau", flag: "🇵🇼", dialCode: "+680", placeholder: "e.g. 775-1234" },
    { code: "PA", name: "Panama", flag: "🇵🇦", dialCode: "+507", placeholder: "e.g. 612-3456" },
    { code: "PG", name: "Papua New Guinea", flag: "🇵🇬", dialCode: "+675", placeholder: "e.g. 7-123-4567" },
    { code: "PY", name: "Paraguay", flag: "🇵🇾", dialCode: "+595", placeholder: "e.g. 98-123-456" },
    { code: "PE", name: "Peru", flag: "🇵🇪", dialCode: "+51", placeholder: "e.g. 9-123-45678" },
    { code: "PL", name: "Poland", flag: "🇵🇱", dialCode: "+48", placeholder: "e.g. 512-123-456" },
    { code: "PT", name: "Portugal", flag: "🇵🇹", dialCode: "+351", placeholder: "e.g. 912-345-678" },
    { code: "PR", name: "Puerto Rico", flag: "🇵🇷", dialCode: "+1-787", placeholder: "e.g. 787-123-4567" },
    { code: "QA", name: "Qatar", flag: "🇶🇦", dialCode: "+974", placeholder: "e.g. 33-123-456" },
    { code: "RO", name: "Romania", flag: "🇷🇴", dialCode: "+40", placeholder: "e.g. 72-123-4567" },
    { code: "RU", name: "Russia", flag: "🇷🇺", dialCode: "+7", placeholder: "e.g. 912-123-4567" },
    { code: "RW", name: "Rwanda", flag: "🇷🇼", dialCode: "+250", placeholder: "e.g. 78-123-4567" },
    { code: "WS", name: "Samoa", flag: "🇼🇸", dialCode: "+685", placeholder: "e.g. 72-123" },
    { code: "SM", name: "San Marino", flag: "🇸🇲", dialCode: "+378", placeholder: "e.g. 54-123-456" },
    { code: "ST", name: "Sao Tome & Principe", flag: "🇸🇹", dialCode: "+239", placeholder: "e.g. 99-1234" },
    { code: "SA", name: "Saudi Arabia", flag: "🇸🇦", dialCode: "+966", placeholder: "e.g. 5-123-4567" },
    { code: "SN", name: "Senegal", flag: "🇸🇳", dialCode: "+221", placeholder: "e.g. 77-123-4567" },
    { code: "RS", name: "Serbia", flag: "🇷🇸", dialCode: "+381", placeholder: "e.g. 64-123-4567" },
    { code: "SC", name: "Seychelles", flag: "🇸🇨", dialCode: "+248", placeholder: "e.g. 251-1234" },
    { code: "SL", name: "Sierra Leone", flag: "🇸🇱", dialCode: "+232", placeholder: "e.g. 76-123-456" },
    { code: "SG", name: "Singapore", flag: "🇸🇬", dialCode: "+65", placeholder: "e.g. 6123-4567" },
    { code: "SK", name: "Slovakia", flag: "🇸🇰", dialCode: "+421", placeholder: "e.g. 0912-123-456" },
    { code: "SI", name: "Slovenia", flag: "🇸🇮", dialCode: "+386", placeholder: "e.g. 31-123-456" },
    { code: "SB", name: "Solomon Islands", flag: "🇸🇧", dialCode: "+677", placeholder: "e.g. 7-1234" },
    { code: "SO", name: "Somalia", flag: "🇸🇴", dialCode: "+252", placeholder: "e.g. 61-123-4567" },
    { code: "ZA", name: "South Africa", flag: "🇿🇦", dialCode: "+27", placeholder: "e.g. 82-123-4567" },
    { code: "ES", name: "Spain", flag: "🇪🇸", dialCode: "+34", placeholder: "e.g. 612-34-56-78" },
    { code: "LK", name: "Sri Lanka", flag: "🇱🇰", dialCode: "+94", placeholder: "e.g. 71-123-4567" },
    { code: "SD", name: "Sudan", flag: "🇸🇩", dialCode: "+249", placeholder: "e.g. 9-123-45678" },
    { code: "SR", name: "Suriname", flag: "🇸🇷", dialCode: "+597", placeholder: "e.g. 9-612-3456" },
    { code: "SE", name: "Sweden", flag: "🇸🇪", dialCode: "+46", placeholder: "e.g. 70-123-4567" },
    { code: "CH", name: "Switzerland", flag: "🇨🇭", dialCode: "+41", placeholder: "e.g. 79-123-45-67" },
    { code: "SY", name: "Syria", flag: "🇸🇾", dialCode: "+963", placeholder: "e.g. 94-123-4567" },
    { code: "TW", name: "Taiwan", flag: "🇹🇼", dialCode: "+886", placeholder: "e.g. 912-345-678" },
    { code: "TJ", name: "Tajikistan", flag: "🇹🇯", dialCode: "+992", placeholder: "e.g. 90-123-4567" },
    { code: "TZ", name: "Tanzania", flag: "🇹🇿", dialCode: "+255", placeholder: "e.g. 71-123-4567" },
    { code: "TH", name: "Thailand", flag: "🇹🇭", dialCode: "+66", placeholder: "e.g. 2-123-4567" },
    { code: "TG", name: "Togo", flag: "🇹🇬", dialCode: "+228", placeholder: "e.g. 90-123-456" },
    { code: "TO", name: "Tonga", flag: "🇹🇴", dialCode: "+676", placeholder: "e.g. 77-1234" },
    { code: "TT", name: "Trinidad and Tobago", flag: "🇹🇹", dialCode: "+1-868", placeholder: "e.g. 628-1234" },
    { code: "TN", name: "Tunisia", flag: "🇹🇳", dialCode: "+216", placeholder: "e.g. 20-123-456" },
    { code: "TR", name: "Turkey", flag: "🇹🇷", dialCode: "+90", placeholder: "e.g. 532-123-4567" },
    { code: "TM", name: "Turkmenistan", flag: "🇹🇲", dialCode: "+993", placeholder: "e.g. 62-123-456" },
    { code: "TV", name: "Tuvalu", flag: "🇹🇻", dialCode: "+688", placeholder: "e.g. 90-123" },
    { code: "UG", name: "Uganda", flag: "🇺🇬", dialCode: "+256", placeholder: "e.g. 77-123-4567" },
    { code: "UA", name: "Ukraine", flag: "🇺🇦", dialCode: "+380", placeholder: "e.g. 67-123-4567" },
    { code: "AE", name: "United Arab Emirates", flag: "🇦🇪", dialCode: "+971", placeholder: "e.g. 50-123-4567" },
    { code: "UY", name: "Uruguay", flag: "🇺🇾", dialCode: "+598", placeholder: "e.g. 99-123-456" },
    { code: "UZ", name: "Uzbekistan", flag: "🇺🇿", dialCode: "+998", placeholder: "e.g. 90-123-4567" },
    { code: "VU", name: "Vanuatu", flag: "🇻🇺", dialCode: "+678", placeholder: "e.g. 55-123" },
    { code: "VE", name: "Venezuela", flag: "🇻🇪", dialCode: "+58", placeholder: "e.g. 412-123-4567" },
    { code: "YE", name: "Yemen", flag: "🇾🇪", dialCode: "+967", placeholder: "e.g. 77-123-4567" },
    { code: "ZM", name: "Zambia", flag: "🇿🇲", dialCode: "+260", placeholder: "e.g. 95-123-4567" },
    { code: "ZW", name: "Zimbabwe", flag: "🇿🇼", dialCode: "+263", placeholder: "e.g. 77-123-4567" }
  ];

  const SearchableCountrySelect = ({ label, value, onChange, compact = false, showDial = false }) => {
    const [open, setOpen] = useState(false);
    const [search, setSearch] = useState("");
    const inputRef = useRef(null);

    const filtered = COUNTRIES.filter(c =>
      c.name.toLowerCase().startsWith(search.toLowerCase()) ||
      c.code.toLowerCase().startsWith(search.toLowerCase()) ||
      c.dialCode.includes(search)
    );

    const selected = COUNTRIES.find(c => c.code === value);

    const handleSelect = (code) => {
      onChange({ target: { value: code } });
      setOpen(false);
      setSearch("");
    };

    return (
      <div style={{ marginBottom: compact ? 0 : 16, position: "relative" }}>
        {label && !compact && <label style={{ display: "block", fontSize: 13, fontWeight: 600, color: BRAND.text, marginBottom: 6 }}>{label}</label>}
        <button
          type="button"
          onClick={() => setOpen(!open)}
          style={{
            width: compact ? 110 : "100%",
            padding: "10px 12px",
            borderRadius: 10,
            height: 42,
            border: `1px solid ${BRAND.border}`,
            fontSize: 14,
            fontFamily: "inherit",
            color: BRAND.text,
            background: "#fff",
            cursor: "pointer",
            textAlign: "left",
            display: "flex",
            alignItems: "center",
            justifyContent: compact ? "flex-start" : "space-between",
          }}
        >
          <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>{selected ? (showDial ? <><span>{selected.flag}</span><span style={{ fontWeight: 700 }}>{selected.dialCode}</span></> : selected.name) : (showDial ? "Select" : "Select country")}</span>
          {!compact && <span style={{ display: "inline-flex", transform: open ? "rotate(180deg)" : "none" }}>{Icons.ChevronDown({ size: 14 })}</span>}
        </button>
        {open && (
          <div style={{
            position: "absolute",
            top: "100%",
            left: compact ? 0 : 0,
            right: compact ? "auto" : 0,
            marginTop: 4,
            background: "#fff",
            border: `1px solid ${BRAND.border}`,
            borderRadius: 10,
            boxShadow: "0 4px 12px rgba(0,0,0,0.15)",
            zIndex: 10,
            maxHeight: 200,
            overflowY: "auto",
          }}>
            <input
              type="text"
              placeholder="Search by name or code..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              autoFocus
              style={{
                width: "100%",
                padding: "8px 12px",
                border: "none",
                borderBottom: `1px solid ${BRAND.border}`,
                fontSize: 13,
                fontFamily: "inherit",
                outline: "none",
                boxSizing: "border-box",
              }}
            />
            {filtered.map(country => (
              <button
                key={country.code}
                type="button"
                onClick={() => handleSelect(country.code)}
                style={{
                  width: "100%",
                  padding: "10px 14px",
                  border: "none",
                  background: value === country.code ? BRAND.primaryLight : "#fff",
                  color: BRAND.text,
                  textAlign: "left",
                  cursor: "pointer",
                  fontSize: 13,
                  borderBottom: `1px solid ${BRAND.border}`,
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                }}
              >
                {showDial ? (
                  <>
                    <span style={{ marginRight: 8 }}>{country.flag}</span>
                    <span>{country.name}</span>
                    <span style={{ marginLeft: "auto", fontSize: 12, color: BRAND.textMuted }}>{country.dialCode}</span>
                  </>
                ) : (
                  <span>{country.name}</span>
                )}
              </button>
            ))}
          </div>
        )}
      </div>
    );
  };

const AuthModal = ({
  open,
  view,
  form,
  loading,
  message,
  onClose,
  onViewChange,
  onChange,
  onSignIn,
  onRegister,
  onResetPassword,
}) => {
  if (!open) return null;

  const copy = {
    signin: {
      title: "Sign in",
      subtitle: "Use your email and password to access CariGaji.",
      action: "Sign in",
    },
    register: {
      title: "Register",
      subtitle: "Create your account and complete your profile and KYC details.",
      action: "Create account",
    },
    reset: {
      title: "Reset password",
      subtitle: "We will send a password reset email to your inbox.",
      action: "Send reset email",
    },
  }[view];

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 300, background: "rgba(17,24,39,0.58)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }} onClick={onClose}>
      <div
        style={{ width: "100%", maxWidth: view === "register" ? 640 : 440, maxHeight: "90vh", background: "#fff", borderRadius: 20, boxShadow: "0 24px 70px rgba(0,0,0,0.3)", overflow: "hidden", display: "flex", flexDirection: "column" }}
        onClick={e => e.stopPropagation()}
      >
        <div style={{ padding: "18px 20px", borderBottom: `1px solid ${BRAND.border}`, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, background: `linear-gradient(135deg, ${BRAND.primaryLight}, #fff)`, flexShrink: 0 }}>
          <div>
            <div style={{ fontSize: 18, fontWeight: 800, color: BRAND.text }}>{copy.title}</div>
            <div style={{ fontSize: 12, color: BRAND.textMuted, marginTop: 4 }}>{copy.subtitle}</div>
          </div>
          <button onClick={onClose} style={{ border: "none", background: "transparent", cursor: "pointer", fontSize: 20, color: BRAND.textMuted, lineHeight: 1 }} aria-label="Close">{Icons.Close({ size: 20 })}</button>
        </div>

        <div style={{ flex: 1, overflowY: "auto", padding: 20, display: "flex", flexDirection: "column" }}>
          {message && (
            <div style={{ margin: "0 0 16px 0", padding: "12px 14px", borderRadius: 12, background: BRAND.grayLight, border: `1px solid ${BRAND.border}`, color: BRAND.text, fontSize: 13, lineHeight: 1.5 }}>
              {message}
            </div>
          )}
          {view === "signin" && (
            <form onSubmit={onSignIn}>
              <Input label="Email address" type="email" placeholder="name@example.com" value={form.email} onChange={e => onChange("email", e.target.value)} />
              <Input label="Password" type="password" placeholder="Enter your password" value={form.password} onChange={e => onChange("password", e.target.value)} />
              <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", marginTop: -6, marginBottom: 16 }}>
                <button type="button" onClick={() => onViewChange("reset")} style={{ border: "none", background: "transparent", color: BRAND.primary, cursor: "pointer", padding: 0, fontSize: 13, fontWeight: 600 }}>Forget password?</button>
                <button type="button" onClick={() => onViewChange("register")} style={{ border: "none", background: "transparent", color: BRAND.primary, cursor: "pointer", padding: 0, fontSize: 13, fontWeight: 600 }}>No account yet? Register Here</button>
              </div>
              <Btn type="submit" disabled={loading} style={{ width: "100%", justifyContent: "center" }}>{copy.action}</Btn>
            </form>
          )}

          {view === "reset" && (
            <form onSubmit={onResetPassword}>
              <Input label="Email address" type="email" placeholder="name@example.com" value={form.email} onChange={e => onChange("email", e.target.value)} />
              <div style={{ fontSize: 12, color: BRAND.textMuted, marginTop: -6, marginBottom: 16, lineHeight: 1.5 }}>We will email you a secure link to reset your password.</div>
              <div style={{ display: "flex", gap: 10, marginBottom: 12 }}>
                <Btn variant="secondary" type="button" onClick={() => onViewChange("signin")} style={{ flex: 1, justifyContent: "center" }}>Back</Btn>
                <Btn type="submit" disabled={loading} style={{ flex: 1, justifyContent: "center" }}>{copy.action}</Btn>
              </div>
            </form>
          )}

          {view === "register" && (
            <form onSubmit={onRegister}>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <Input label="Full name *" placeholder="e.g. Nurul Ain Hassan" value={form.fullName} onChange={e => onChange("fullName", e.target.value)} />
                  <SearchableCountrySelect label="Country *" value={form.countryOfOrigin} onChange={e => onChange("countryOfOrigin", e.target.value)} />
              </div>
                <div style={{ marginBottom: 16 }}>
                  <label style={{ display: "block", fontSize: 13, fontWeight: 600, color: BRAND.text, marginBottom: 6 }}>Phone number *</label>
                  <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 6 }}>
                    <div style={{ flex: "0 0 auto" }}>
                      <SearchableCountrySelect value={form.countryCode} onChange={e => onChange("countryCode", e.target.value)} compact showDial />
                    </div>
                    <div style={{ flex: 1 }}>
                      <Input 
                        placeholder={COUNTRIES.find(c => c.code === form.countryCode)?.placeholder || "Enter phone number"}
                        value={form.phone} 
                        onChange={e => onChange("phone", e.target.value)} 
                        style={{ marginBottom: 0 }}
                      />
                    </div>
                  </div>
                </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <Input label="Email address *" type="email" placeholder="name@example.com" value={form.email} onChange={e => onChange("email", e.target.value)} />
                <PasswordInput label="Password *" placeholder="Create a password" value={form.password} onChange={e => onChange("password", e.target.value)} />
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <PasswordInput label="Confirm password *" placeholder="Re-type your password" value={form.confirmPassword} onChange={e => onChange("confirmPassword", e.target.value)} hideToggle={true} />
              </div>
              {form.confirmPassword !== "" && form.password !== form.confirmPassword && (
                <div style={{ color: BRAND.red, fontSize: 13, marginTop: -8, marginBottom: 12 }}>Passwords do not match.</div>
              )}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <Select
                  label="Identity type *"
                  value={form.identityType}
                  onChange={e => {
                    const nextType = e.target.value;
                    onChange("identityType", nextType);
                    onChange("idNumber", "");
                  }}
                  options={[
                    { value: "MyKad", label: "IC (MyKad)" },
                    { value: "Passport", label: "Passport" },
                    { value: "MyPR", label: "MyPR" },
                  ]}
                />
                <Input
                  label={form.identityType === "MyKad" ? "MyKad Number *" : form.identityType === "MyPR" ? "MyPR Number *" : "Passport Number *"}
                  placeholder={["MyKad", "MyPR"].includes(form.identityType) ? "XXXXXX-XX-XXXX" : "A1234567"}
                  value={form.idNumber}
                  onChange={e => {
                    const formatted = formatIdentityNumber(e.target.value, form.identityType);
                    onChange("idNumber", formatted);
                    if (form.identityType === "MyKad") {
                      const extractedDate = extractDateFromIC(formatted);
                      if (extractedDate) onChange("dateOfBirth", extractedDate);
                    }
                  }}
                />
              </div>
              <Input
                label="Date of birth *"
                type="date"
                value={form.dateOfBirth}
                onChange={e => onChange("dateOfBirth", e.target.value)}
              />
              <div style={{ fontSize: 12, color: BRAND.textMuted, lineHeight: 1.5, marginTop: -12, marginBottom: 16 }}>
                Your KYC level will be assigned based on uploaded documents.
              </div>
              <Input label="Address *" placeholder="Street, city, state" value={form.address} onChange={e => onChange("address", e.target.value)} />
              <div style={{ fontSize: 13, fontWeight: 700, color: BRAND.text, marginBottom: 10 }}>KYC documents</div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <FileInput label="MyKad front *" accept="image/*,application/pdf" onChange={e => onChange("kycFront", e.target.files?.[0] || null)} fileName={form.kycFront?.name} helper="Upload a photo or PDF of the front side." />
                <FileInput label="MyKad back *" accept="image/*,application/pdf" onChange={e => onChange("kycBack", e.target.files?.[0] || null)} fileName={form.kycBack?.name} helper="Upload a photo or PDF of the back side." />
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <FileInput label="Selfie *" accept="image/*" onChange={e => onChange("selfie", e.target.files?.[0] || null)} fileName={form.selfie?.name} helper="Upload a clear selfie for identity verification." />
                <FileInput label="Certification" accept="image/*,application/pdf" onChange={e => onChange("supportingDoc", e.target.files?.[0] || null)} fileName={form.supportingDoc?.name} helper="Optional: food handler, first aid, or other certifications." />
              </div>
              <div style={{ fontSize: 12, color: BRAND.textMuted, lineHeight: 1.5, marginTop: -4, marginBottom: 16 }}>
                Add your personal and KYC details now. Selected files will be uploaded to Supabase Storage during registration.
              </div>
              <div style={{ display: "flex", gap: 10 }}>
                <Btn variant="secondary" type="button" onClick={() => onViewChange("signin")} style={{ flex: 1, justifyContent: "center" }}>Back</Btn>
                <Btn type="submit" disabled={loading || (form.password !== form.confirmPassword) || form.password === ""} style={{ flex: 1, justifyContent: "center" }}>{copy.action}</Btn>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  );
};

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
const WorkerPortal = ({ onOpenPortal, isMobile = false, user = null }) => {
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
  const [liveApplications, setLiveApplications] = useState(null);

  const navHeight = isMobile ? 60 : 72;
  const navPadding = navHeight + 16;

  useEffect(() => {
    let active = true;
    const loadApplications = async () => {
      if (!user) return setLiveApplications(null);
      const { data, error } = await supabase
        .from('applications')
        .select('id, wage_ask, status, applied_at, shift:shifts(title, start_at)')
        .eq('worker_id', user.id)
        .order('applied_at', { ascending: false });
      if (!active) return;
      if (error) { setLiveApplications(null); return; }
      setLiveApplications((data ?? []).map(a => ({
        id: a.id,
        shiftTitle: a.shift?.title ?? 'Shift',
        employer: '',
        date: a.shift?.start_at ? new Date(a.shift.start_at).toLocaleDateString('en-MY') : 'TBA',
        wageBid: Number(a.wage_ask ?? 0),
        status: a.status,
      })));
    };
    loadApplications();
    return () => { active = false; };
  }, [user]);

  const cats = ["All", "F&B", "Retail", "Event", "Logistics"];
  const filtered = filterCat === "All" ? SHIFTS.filter(s => s.status === "open") : SHIFTS.filter(s => s.category === filterCat && s.status === "open");

  const sendMsg = () => {
    if (!chatMsg.trim()) return;
    setMessages(m => [...m, { id: m.length + 1, from: "worker", name: "You", text: chatMsg, time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) }]);
    setChatMsg("");
  };

  const navItems = [
    { id: "discover", label: "Discover", icon: <Icons.Search size={20} /> },
    { id: "applications", label: "My Bids", icon: <Icons.List size={20} /> },
    { id: "earnings", label: "Earnings", icon: <Icons.Money size={20} /> },
    { id: "profile", label: "Profile", icon: <Icons.User size={20} /> },
    { id: "settings", label: "Settings", icon: <Icons.Settings size={20} /> },
  ];

  const handleWorkerNavClick = (nextTab) => {
    setShowQR(false);
    setShowChat(false);
    setShowBidModal(false);
    setSelectedShift(null);
    setTab(nextTab);
  };

  // Modal content - rendered on top of main content
  if (showQR) return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", width: "100%", minHeight: 0 }}>
      <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 32, paddingBottom: navPadding, background: "#fff", overflow: "auto", minHeight: 0 }}>
        <div style={{ fontSize: 24, fontWeight: 800, color: BRAND.text, marginBottom: 8 }}>Check-in QR Scanner</div>
        <div style={{ color: BRAND.textMuted, fontSize: 14, marginBottom: 32, textAlign: "center" }}>Point your camera at the QR code at the venue entrance</div>
        <div style={{ width: 220, height: 220, background: BRAND.grayLight, borderRadius: 20, display: "flex", alignItems: "center", justifyContent: "center", border: `3px dashed ${BRAND.border}`, marginBottom: 24 }}>
          <div style={{ textAlign: "center" }}>
            <div style={{ fontSize: 48 }}>{Icons.Camera({ size: 48 })}</div>
            <div style={{ fontSize: 12, color: BRAND.textMuted, marginTop: 8 }}>Camera viewfinder</div>
          </div>
        </div>
        <div style={{ background: BRAND.greenLight, color: "#065F46", borderRadius: 12, padding: "12px 20px", fontSize: 14, fontWeight: 600, marginBottom: 16 }}>✓ GPS: KLCC (1.5km — within range)</div>
        <Btn onClick={() => { setShowQR(false); alert("✅ Checked in at 18:02! Reliability +0 (on time)"); }}>Simulate Successful Check-in</Btn>
        <Btn variant="secondary" onClick={() => setShowQR(false)} style={{ marginTop: 8 }}>Back</Btn>
      </div>
      <div style={{ position: "fixed", left: 0, right: 0, bottom: 0, width: "100%", zIndex: 1000, boxShadow: "0 -6px 20px rgba(0,0,0,0.08)", borderTop: `1px solid ${BRAND.border}`, background: "#fff", display: "flex", flexShrink: 0, minHeight: navHeight }}>
        {navItems.map(n => (
          <button key={n.id} onClick={() => handleWorkerNavClick(n.id)} style={{
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

  if (showChat) return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", width: "100%", minHeight: 0 }}>
      <div style={{ padding: "16px 20px", borderBottom: `1px solid ${BRAND.border}`, display: "flex", alignItems: "center", gap: 12, background: "#fff", flexShrink: 0 }}>
        <button onClick={() => setShowChat(false)} style={{ background: "none", border: "none", fontSize: 20, cursor: "pointer", color: BRAND.text }} aria-label="Back">{Icons.ArrowLeft({ size: 18 })}</button>
        <Avatar name="Grand Hyatt KL" size={36} color={BRAND.blue} />
        <div>
          <div style={{ fontWeight: 700, fontSize: 14, color: BRAND.text }}>Grand Hyatt KL</div>
          <div style={{ fontSize: 12, color: BRAND.green }}>● Online</div>
        </div>
        <div style={{ marginLeft: "auto" }}>
          <Badge color="orange">F&B Server Shift</Badge>
        </div>
      </div>
      <div style={{ flex: 1, overflowY: "auto", padding: 16, paddingBottom: navPadding, display: "flex", flexDirection: "column", gap: 12, background: BRAND.grayLight, minHeight: 0 }}>
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
      <div style={{ padding: 16, borderTop: `1px solid ${BRAND.border}`, background: "#fff", display: "flex", gap: 8, flexShrink: 0, marginBottom: navHeight }}>
        <input value={chatMsg} onChange={e => setChatMsg(e.target.value)} onKeyDown={e => e.key === "Enter" && sendMsg()}
          placeholder="Type a message…"
          style={{ flex: 1, padding: "10px 14px", borderRadius: 10, border: `1px solid ${BRAND.border}`, fontSize: 14, fontFamily: "inherit", outline: "none" }}
        />
        <Btn onClick={sendMsg}>Send</Btn>
      </div>
      <div style={{ position: "fixed", left: 0, right: 0, bottom: 0, width: "100%", zIndex: 1000, boxShadow: "0 -6px 20px rgba(0,0,0,0.08)", borderTop: `1px solid ${BRAND.border}`, background: "#fff", display: "flex", flexShrink: 0, minHeight: navHeight }}>
        {navItems.map(n => (
          <button key={n.id} onClick={() => handleWorkerNavClick(n.id)} style={{
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

  // Shift detail view with bottom nav
  if (selectedShift) return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", width: "100%", minHeight: 0 }}>
      {showBidModal && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", display: "flex", alignItems: "flex-end", zIndex: 100, borderRadius: 20 }}>
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
                (async () => {
                  if (!bidAmount) return;
                  if (parseFloat(bidAmount) > selectedShift.wageMax * 1.5) { alert(`Max bid is RM${(selectedShift.wageMax * 1.5).toFixed(0)}/h`); return; }
                  if (!user) { alert('Please sign in before applying.'); return; }
                  // Guard: mock shifts use numeric ids — require a real UUID id to insert
                  if (typeof selectedShift.id !== 'string' || !selectedShift.id.includes('-')) {
                    alert('Cannot apply to a mock shift. Please use a real shift from the database.');
                    return;
                  }

                  const payload = {
                    shift_id: selectedShift.id,
                    worker_id: user.id,
                    wage_ask: Number(bidAmount),
                  };

                  const { data, error } = await supabase.from('applications').insert(payload).select();
                  if (error) {
                    // Unique constraint or FK errors will appear here
                    alert('Failed to submit application: ' + error.message);
                    return;
                  }

                  // Update local UI state and liveApplications cache if present
                  setShowBidModal(false);
                  setBidSuccess(true);
                  setLiveApplications(prev => prev ? [{ id: data[0].id, shiftId: selectedShift.id, shiftTitle: selectedShift.title, employer: selectedShift.employer, date: selectedShift.date, wageBid: Number(bidAmount), status: data[0].status || 'pending', appliedAt: data[0].applied_at }, ...prev] : null);
                  setTimeout(() => { setBidSuccess(false); setSelectedShift(null); setTab('applications'); }, 2000);
                })();
              }} style={{ flex: 1 }}>Submit Bid →</Btn>
            </div>
          </div>
        </div>
      )}
      {bidSuccess && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 200, borderRadius: 20 }}>
          <div style={{ background: "#fff", borderRadius: 20, padding: isMobile ? 24 : 32, textAlign: "center" }}>
            <div style={{ fontSize: isMobile ? 40 : 48, marginBottom: 12 }}>🎉</div>
            <div style={{ fontWeight: 800, fontSize: isMobile ? 18 : 20, color: BRAND.text }}>Bid Submitted!</div>
            <div style={{ color: BRAND.textMuted, fontSize: isMobile ? 12 : 14, marginTop: 8 }}>RM{bidAmount}/h · You'll be notified when shortlisted</div>
          </div>
        </div>
      )}
      <div style={{ flex: 1, overflowY: "auto", paddingBottom: navPadding, display: "flex", flexDirection: "column", minHeight: 0 }}>
        <div style={{ background: `linear-gradient(135deg, ${BRAND.primary}, #C0280A)`, padding: isMobile ? "32px 16px 16px" : "48px 24px 24px", borderRadius: isMobile ? 0 : "20px 20px 0 0", flexShrink: 0 }}>
          <button onClick={() => setSelectedShift(null)} style={{ background: "rgba(255,255,255,0.2)", border: "none", color: "#fff", borderRadius: 8, padding: "6px 12px", cursor: "pointer", fontSize: 13, marginBottom: 12, fontFamily: "inherit" }} aria-label="Back">{Icons.ArrowLeft({ size: 14 })} <span style={{ marginLeft: 8 }}>Back</span></button>
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
          <Btn onClick={() => setShowBidModal(true)} style={{ width: "100%", justifyContent: "center", fontSize: isMobile ? 14 : 16, padding: isMobile ? "12px 0" : "14px 0", marginBottom: 20 }}>
            Place Bid →
          </Btn>
        </div>
      </div>
      <div style={{ position: "fixed", left: 0, right: 0, bottom: 0, width: "100%", zIndex: 1000, boxShadow: "0 -6px 20px rgba(0,0,0,0.08)", borderTop: `1px solid ${BRAND.border}`, background: "#fff", display: "flex", flexShrink: 0, minHeight: navHeight }}>
        {navItems.map(n => (
          <button key={n.id} onClick={() => handleWorkerNavClick(n.id)} style={{
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

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", width: "100%", minHeight: 0 }}>
      {/* Content */}
      <div style={{ flex: 1, overflowY: "auto", padding: tab === "discover" ? 0 : isMobile ? 12 : 20, paddingBottom: navPadding, width: "100%", minHeight: 0 }}>
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
              {(liveApplications ?? APPLICATIONS).map(a => (
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
              <Stat label="Rating" value={<span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><span>4.7</span>{Icons.Star({ size: 14 })}</span>} color={BRAND.accent} />
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
      <div style={{ position: "fixed", left: 0, right: 0, bottom: 0, width: "100%", zIndex: 1000, boxShadow: "0 -6px 20px rgba(0,0,0,0.08)", borderTop: `1px solid ${BRAND.border}`, background: "#fff", display: "flex", flexShrink: 0, minHeight: navHeight }}>
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
const EmployerPortal = ({ onOpenPortal, compact = false, user = null }) => {
  const [view, setView] = useState("dashboard");
  const [selectedShift, setSelectedShift] = useState(null);
  const [postStep, setPostStep] = useState(1);
  const [form, setForm] = useState({ title: "", category: "F&B", date: "", timeStart: "", timeEnd: "", wageMin: "", wageMax: "", headcount: 1, dress: "", location: "KLCC, KL City Centre" });
  const [applicantAction, setApplicantAction] = useState({});
  const [liveEmployerShifts, setLiveEmployerShifts] = useState(null);

  useEffect(() => {
    let active = true;
    const load = async () => {
      if (!user) return setLiveEmployerShifts(null);
      const { data, error } = await supabase
        .from('shifts')
        .select('id, title, category, start_at, end_at, headcount, filled_count, status')
        .eq('employer_id', user.id)
        .order('start_at', { ascending: false });
      if (!active) return;
      if (error) { setLiveEmployerShifts(null); return; }
      setLiveEmployerShifts((data ?? []).map(s => ({
        id: s.id,
        title: s.title,
        date: s.start_at ? new Date(s.start_at).toLocaleDateString('en-MY') : 'TBA',
        time: s.start_at && s.end_at ? `${new Date(s.start_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}–${new Date(s.end_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : 'TBA',
        headcount: s.headcount ?? 1,
        filled: s.filled_count ?? 0,
        applicants: 0,
        status: s.status,
        escrow: 0,
        category: s.category,
      })));
    };
    load();
    return () => { active = false; };
  }, [user]);

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
                {(liveEmployerShifts ?? EMPLOYER_SHIFTS).filter(s => s.status !== "draft").map(s => (
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
            {(liveEmployerShifts ?? EMPLOYER_SHIFTS).map(s => (
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
            <button onClick={() => setSelectedShift(null)} style={{ background: "none", border: "none", cursor: "pointer", fontSize: 14, color: BRAND.primary, fontFamily: "inherit", marginBottom: 16 }} aria-label="Back to shifts">{Icons.ArrowLeft({ size: 14 })} <span style={{ marginLeft: 8 }}>Back to shifts</span></button>
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
                    <Btn variant="secondary" onClick={() => setPostStep(1)} style={{ flex: 1, justifyContent: "center" }}>{Icons.ArrowLeft({ size: 14 })} <span style={{ marginLeft: 8 }}>Back</span></Btn>
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
                    <Btn variant="secondary" onClick={() => setPostStep(2)} style={{ flex: 1, justifyContent: "center" }}>{Icons.ArrowLeft({ size: 14 })} <span style={{ marginLeft: 8 }}>Back</span></Btn>
                    <Btn onClick={() => { alert("✅ Shift published! Workers will start applying within minutes."); setView("shifts"); setPostStep(1); }} style={{ flex: 1, justifyContent: "center" }}>{Icons.Rocket({ size: 14 })} <span style={{ marginLeft: 8 }}>Publish Shift</span></Btn>
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
  const [user, setUser] = useState(null);
  const [authOpen, setAuthOpen] = useState(false);
  const [authView, setAuthView] = useState("signin");
  const [authLoading, setAuthLoading] = useState(false);
  const [authMessage, setAuthMessage] = useState("");
  const [authForm, setAuthForm] = useState({
    fullName: "",
      countryCode: "MY",
    countryOfOrigin: "MY",
    phone: "",
    email: "",
    password: "",
    confirmPassword: "",
    identityType: "MyKad",
    idNumber: "",
    dateOfBirth: "",
    kycLevel: "Basic",
    address: "",
    kycFront: null,
    kycBack: null,
    selfie: null,
    supportingDoc: null,
  });
  const [viewport, setViewport] = useState({ width: typeof window !== "undefined" ? window.innerWidth : 0, height: typeof window !== "undefined" ? window.innerHeight : 0 });

  const openAuthModal = (view = "signin") => {
    setAuthView(view);
    setAuthMessage("");
    setAuthOpen(true);
  };

  const updateAuthField = (field, value) => {
    setAuthForm(prev => ({ ...prev, [field]: value }));
  };

  const authRedirectUrl = typeof window !== "undefined" ? `${window.location.origin}${window.location.pathname}` : undefined;

  const handleSignIn = async (event) => {
    event.preventDefault();
    setAuthLoading(true);
    setAuthMessage("");
    const { error } = await supabase.auth.signInWithPassword({
      email: authForm.email,
      password: authForm.password,
    });
    setAuthLoading(false);
    if (error) {
      setAuthMessage(error.message);
      return;
    }
    setAuthOpen(false);
    setAuthForm(prev => ({ ...prev, password: "" }));
  };

  const handleResetPassword = async (event) => {
    event.preventDefault();
    setAuthLoading(true);
    setAuthMessage("");
    const { error } = await supabase.auth.resetPasswordForEmail(authForm.email, { redirectTo: authRedirectUrl });
    setAuthLoading(false);
    if (error) {
      setAuthMessage(error.message);
      return;
    }
    setAuthMessage("Password reset email sent. Check your inbox to continue.");
  };

  const handleRegister = async (event) => {
    event.preventDefault();
    if (authForm.password !== authForm.confirmPassword) {
      setAuthMessage("Passwords do not match.");
      return;
    }
    setAuthLoading(true);
    setAuthMessage("");
    const autoKycLevel = assignKYCLevel(
      Boolean(authForm.kycFront),
      Boolean(authForm.kycBack),
      Boolean(authForm.selfie),
      Boolean(authForm.supportingDoc)
    );
    const { data, error } = await supabase.auth.signUp({
      email: authForm.email,
      password: authForm.password,
      options: {
        emailRedirectTo: authRedirectUrl,
        data: {
          full_name: authForm.fullName,
            phone: `${COUNTRIES.find(c => c.code === authForm.countryCode)?.dialCode || "+60"}${authForm.phone}`,
          identity_type: authForm.identityType,
          id_number: authForm.idNumber,
          date_of_birth: authForm.dateOfBirth,
          kyc_level: autoKycLevel,
          address: authForm.address,
        },
      },
    });
    if (error) {
      setAuthLoading(false);
      setAuthMessage(error.message);
      return;
    }

    const registeredUserId = data?.user?.id;
    const hasSession = Boolean(data?.session);
    if (registeredUserId && hasSession) {
      try {
        const uploadTasks = [
          ["kyc_front", authForm.kycFront],
          ["kyc_back", authForm.kycBack],
          ["selfie", authForm.selfie],
          ["supporting_doc", authForm.supportingDoc],
        ]
          .filter(([, file]) => file)
          .map(async ([label, file]) => [label, await uploadKycFile(registeredUserId, file, label)]);

        const uploadedEntries = await Promise.all(uploadTasks);
        const kycRefs = Object.fromEntries(uploadedEntries);

        if (Object.keys(kycRefs).length > 0) {
          const { error: profileError } = await supabase.auth.updateUser({
            data: {
              ...data.user.user_metadata,
              ...kycRefs,
            },
          });
          if (profileError) throw profileError;
        }

        setAuthMessage("Registration completed. Your KYC documents were uploaded successfully.");
      } catch (uploadError) {
        setAuthMessage(`Registration completed, but KYC upload needs attention: ${uploadError.message}`);
      }
    } else {
      setAuthMessage("Registration submitted. Check your email if confirmation is enabled, then sign in to finish KYC upload.");
    }

    setAuthLoading(false);
    setAuthForm({
      fullName: "",
        countryCode: "MY",
      countryOfOrigin: "MY",
      phone: "",
      email: "",
      password: "",
      confirmPassword: "",
      identityType: "MyKad",
      idNumber: "",
      dateOfBirth: "",
      kycLevel: "Basic",
      address: "",
      kycFront: null,
      kycBack: null,
      selfie: null,
      supportingDoc: null,
    });
  };

  useEffect(() => {
    let mounted = true;
    (async () => {
      const { data } = await supabase.auth.getUser();
      if (!mounted) return;
      setUser(data?.user ?? null);
    })();

    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null);
    });

    return () => { mounted = false; sub.subscription.unsubscribe(); };
  }, []);

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
      width: "100%",
      background: isMobile
        ? `linear-gradient(180deg, ${BRAND.primary}08 0%, #fff 18%, #fff 100%)`
        : `radial-gradient(circle at top, ${BRAND.primary}20 0%, #140806 42%, ${BRAND.dark} 100%)`,
      display: "flex",
      alignItems: "stretch",
      justifyContent: "stretch",
      padding: 0,
      fontFamily: "'DM Sans', system-ui, sans-serif",
    }}>
      <div style={{
        width: "100%",
        height: "100%",
        minHeight: "100vh",
        background: isMobile ? "#fff" : "rgba(255,255,255,0.98)",
        borderRadius: isMobile ? 0 : 0,
        overflow: "auto",
        border: "none",
        boxShadow: "none",
        position: "relative",
        display: "flex",
        flexDirection: "column",
        flex: 1,
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
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            {!isMobile && (
              <Badge color={portal === "worker" ? "green" : portal === "employer" ? "blue" : "amber"}>
                {cfg.label}
              </Badge>
            )}
            {user ? (
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <div style={{ fontSize: 13, color: BRAND.textMuted }}>{user.email}</div>
                <Btn size="sm" variant="ghost" onClick={async () => { await supabase.auth.signOut(); setUser(null); }}>Sign out</Btn>
              </div>
            ) : (
              <Btn size="sm" variant="primary" onClick={() => openAuthModal("signin")}>Sign in</Btn>
            )}
          </div>
        </div>
        <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
          {portal === "worker" && <WorkerPortal onOpenPortal={setPortal} isMobile={isMobile} user={user} />}
          {portal === "employer" && <EmployerPortal onOpenPortal={setPortal} compact={isMobile} user={user} />}
          {portal === "admin" && <AdminPortal onOpenPortal={setPortal} compact={isMobile} user={user} />}
        </div>
      </div>
      <AuthModal
        open={authOpen}
        view={authView}
        form={authForm}
        loading={authLoading}
        message={authMessage}
        onClose={() => setAuthOpen(false)}
        onViewChange={view => {
          setAuthView(view);
          setAuthMessage("");
        }}
        onChange={updateAuthField}
        onSignIn={handleSignIn}
        onRegister={handleRegister}
        onResetPassword={handleResetPassword}
      />
    </div>
  );
}