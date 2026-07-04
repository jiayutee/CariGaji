import { useState, useEffect, useRef, useMemo, useCallback, useContext, createContext, memo } from "react";
import { supabase } from "./src/lib/supabase.js";
import { runInternalPayoutScheduling } from "./src/lib/payouts/scheduler.js";
import { applyThemeToDocument, buildThemeVars, cycleThemePreference, getSystemTheme, readThemePreference, resolveThemeMode, writeThemePreference } from "./src/lib/theme.js";

// ─── Design tokens ─────────────────────────────────────────────────────────
const BRAND = {
  primary: "#2563EB",
  primaryDark: "#1D4ED8",
  primaryLight: "#EFF4FF",
  primaryMid: "#BBD0FF",
  dark: "#0A1428",
  accent: "#0891B2",
  accentLight: "#E0F7FB",
  green: "#1A9E5C",
  greenLight: "#E8F7EF",
  blue: "#0284C7",
  blueLight: "#E0F2FE",
  amber: "#D97706",
  amberLight: "#FEF3C7",
  red: "#DC2626",
  redLight: "#FEE2E2",
  gray: "var(--cg-text-muted)",
  grayLight: "var(--cg-surface-muted)",
  surface: "var(--cg-surface)",
  surfaceElevated: "var(--cg-surface-elevated)",
  panel: "var(--cg-panel)",
  input: "var(--cg-input)",
  page: "var(--cg-page)",
  border: "var(--cg-border)",
  text: "var(--cg-text)",
  textMuted: "var(--cg-text-muted)",
  shadow: "var(--cg-shadow)",
  overlay: "var(--cg-overlay)",
};

// ─── i18n dictionary (v1 foundation — core strings only, not exhaustive) ────
const TRANSLATIONS = {
  en: {
    "nav.discover": "Discover",
    "nav.myBids": "My Bids",
    "nav.chat": "Chat",
    "nav.earnings": "Earnings",
    "nav.profile": "Profile",
    "nav.settings": "Settings",
    "settings.title": "Settings",
    "settings.subtitle": "Manage your account and access hidden consoles",
    "settings.account": "Account",
    "settings.language": "Language",
    "settings.languageEnglish": "English",
    "settings.languageBM": "Bahasa Melayu",
    "settings.notifications": "Notifications",
    "settings.notificationsValue": "Enabled",
    "settings.privacy": "Privacy",
    "settings.privacyValue": "Standard worker mode",
    "common.signIn": "Sign in",
    "common.createAccount": "Create account",
    "common.postAShift": "Post a Shift",
    "common.accept": "Accept",
    "common.reject": "Reject",
    "common.submitBid": "Submit Bid →",
    "common.placeBid": "Place Bid →",
    "common.signInToBid": "Sign in to bid →",
    "toast.avatarUpdated": "Profile picture updated.",
    "toast.avatarUpdateFailed": "Could not update photo: ",
    "toast.sendFailed": "Failed to send: ",
    "toast.checkinSimulated": "Checked in at 18:02 · Reliability maintained (on time)",
    "toast.maxBidPrefix": "Max bid is RM",
    "toast.sampleShiftBidInfo": "This is a sample shift. Apply to a live shift to submit a bid.",
    "toast.applicationFailed": "Failed to submit application: ",
    "toast.signFailed": "Failed to sign: ",
    "toast.contractSigned": "✅ Contract signed! You can now chat with your employer.",
    "toast.updateFailed": "Update failed: ",
    "toast.escrowTopupUnavailable": "Escrow top-up isn’t available yet — coming with FPX/DuitNow integration.",
    "toast.signInToPostShift": "Sign in to post a shift.",
    "toast.shiftFieldsRequired": "Title, date, and start/end times are required.",
    "toast.maxPayGteMinPay": "Max pay must be ≥ min pay.",
    "toast.postShiftFailed": "Failed to post shift: ",
    "toast.shiftPublished": "Shift published! Workers will start applying shortly.",
    "toast.contractSent": "✅ Contract sent to worker for signature!",
    "chat.signInTitle": "Sign in to view messages",
    "chat.signInHint": "Messages with employers appear here once you're signed in and have an accepted bid.",
    "chat.title": "💬 Messages",
    "chat.emptyTitleWorker": "No accepted shifts yet.",
    "chat.emptyHintWorker": "Messages appear here once an employer accepts your bid.",
    "chat.emptyTitleEmployer": "No accepted applications yet.",
    "chat.emptyHintEmployer": "Chats appear here once you accept a worker's bid.",
    "chat.employerSubtitle": "Chat with workers on accepted shifts",
    "chat.loading": "Loading...",
    "chat.inputPlaceholder": "Type a message…",
    "chat.send": "Send",
    "common.back": "Back",
    "common.cancel": "Cancel",
    "shiftDetail.placeBidTitle": "Place Your Bid",
    "shiftDetail.employerRange": "Employer range: RM",
    "shiftDetail.maxBid": " · Max bid: RM",
    "shiftDetail.wageAskLabel": "Your wage ask (RM/hour)",
    "shiftDetail.estimatedTotalPay": "Estimated total pay",
    "shiftDetail.transportAllowanceSuffix": " transport allowance",
    "shiftDetail.bidSubmitted": "Bid Submitted!",
    "shiftDetail.bidSubmittedHint": "You'll be notified when shortlisted",
    "shiftDetail.positions": "Positions",
    "shiftDetail.applied": "Applied",
    "shiftDetail.wageRange": "Wage Range",
    "shiftDetail.perHour": "per hour",
    "shiftDetail.shiftDuration": "Shift Duration",
    "shiftDetail.estimatedGross": "Estimated Gross",
    "shiftDetail.atMaxRate": "at max rate",
    "shiftDetail.transportAllowance": "Transport Allowance",
    "shiftDetail.title": "Shift Details",
    "shiftDetail.aboutRole": "About this role",
    "shiftDetail.location": "📍 Location",
    "shiftDetail.date": "🗓 Date",
    "shiftDetail.time": "⏰ Time",
    "shiftDetail.dressCode": "👗 Dress Code",
    "shiftDetail.headcount": "👥 Headcount",
    "shiftDetail.workersNeeded": "workers needed",
    "shiftDetail.employerScore": "🏢 Employer Score",
    "shiftDetail.locationNote": "Exact address revealed once your application is accepted.",
    "shiftDetail.employerReliability": "Employer Reliability",
    "shiftDetail.applicants": "applicants",
    "profile.signInTitle": "Sign in to view your profile",
    "profile.signInHint": "Your KYC status, reliability score, ratings, and shift history live here once you sign in.",
    "profile.changePhoto": "Change profile picture",
    "profile.standardKyc": "Standard KYC",
    "profile.reliabilitySuffix": "Reliability",
    "profile.shiftsDone": "Shifts done",
    "profile.rating": "Rating",
    "profile.strikes": "Strikes",
    "profile.cleanRecord": "Clean record",
    "profile.onTimeRate": "On-time rate",
    "profile.kycVerification": "KYC Verification",
    "profile.kycBasic": "Basic (Phone/Email)",
    "profile.kycStandard": "Standard (MyKad + Selfie)",
    "profile.kycAdvanced": "Advanced (Certifications)",
    "profile.verified": "✓ Verified",
    "profile.reliabilityScoreLabel": "Reliability Score: ",
    "profile.reliabilityExcellent": "Excellent — top 15% of workers 🏆",
    "profile.reliabilityGood": "Good standing — keep it up 👍",
    "profile.reliabilityBuilding": "Building your reputation 📈",
    "profile.reliabilityLow": "Complete more shifts to improve your score",
    "profile.recentRatings": "Recent Ratings",
    "profile.noRatingsTitle": "No ratings yet",
    "profile.noRatingsHint": "Ratings from employers will appear here after you complete shifts.",
    "auth.signinSubtitle": "Use your email and password to access CariGaji.",
    "auth.registerTitle": "Register",
    "auth.registerSubtitle": "Create your account and complete your profile and KYC details.",
    "auth.resetTitle": "Reset password",
    "auth.resetSubtitle": "We will send a password reset email to your inbox.",
    "auth.sendResetEmail": "Send reset email",
    "auth.emailAddress": "Email address",
    "auth.password": "Password",
    "auth.forgetPassword": "Forget password?",
    "auth.noAccountYet": "No account yet? Register Here",
    "auth.resetHint": "We will email you a secure link to reset your password.",
    "auth.fullName": "Full name *",
    "auth.country": "Country *",
    "auth.phoneNumber": "Phone number *",
    "auth.emailAddressReq": "Email address *",
    "auth.passwordReq": "Password *",
    "auth.createPassword": "Create a password",
    "auth.confirmPasswordReq": "Confirm password *",
    "auth.retypePassword": "Re-type your password",
    "auth.passwordsNoMatch": "Passwords do not match.",
    "auth.identityType": "Identity type *",
    "auth.icMyKad": "IC (MyKad)",
    "auth.passport": "Passport",
    "auth.myPR": "MyPR",
    "auth.myKadNumber": "MyKad Number *",
    "auth.myPRNumber": "MyPR Number *",
    "auth.passportNumber": "Passport Number *",
    "auth.dateOfBirth": "Date of birth *",
    "auth.underageWarning": "You must be at least {age} years old to register and work on CariGaji.",
    "auth.kycLevelNote": "Your KYC level will be assigned based on uploaded documents.",
    "auth.address": "Address *",
    "auth.addressPlaceholder": "Street, city, state",
    "auth.uploadDocuments": "Upload documents",
    "auth.uploadDocumentsHint": "Upload clear photos of your {doc}. The identity number must be readable and match what you entered above.",
    "auth.passportDoc": "passport",
    "auth.myPRCardDoc": "MyPR card",
    "auth.myKadDoc": "MyKad",
    "auth.uploadFrontHelper": "Upload a photo or PDF of the front side.",
    "auth.uploadBackHelper": "Upload a photo or PDF of the back side.",
    "auth.ocrChecking": "Checking the ID number on your photo…",
    "auth.ocrMatch": "✓ The identity number on your photo matches what you entered.",
    "auth.ocrMismatchTitle": "We couldn't match the ID number on your photo to what you typed.",
    "auth.ocrMismatchHint": "This usually means one of:",
    "auth.ocrMismatchReason1": "the photo is blurry or the number isn't fully visible,",
    "auth.ocrMismatchReason2": "the identity number you entered has a typo, or",
    "auth.ocrMismatchReason3": "the wrong document photo was uploaded.",
    "auth.ocrMismatchAction": "Please double-check both. You can still submit — our team will verify manually.",
    "auth.selfie": "Selfie *",
    "auth.selfieHelper": "Upload a clear selfie for identity verification.",
    "auth.certification": "Certification",
    "auth.certificationHelper": "Optional: food handler, first aid, or other certifications.",
    "auth.finalRegisterHint": "Add your personal and KYC details now. Selected files will be uploaded to Supabase Storage during registration.",
    "auth.pleaseCompleteFields": "Please complete the highlighted fields:",
    "auth.docMyKadFront": "MyKad (front)",
    "auth.docMyKadBack": "MyKad (back)",
    "auth.docMyPRFront": "MyPR card (front)",
    "auth.docMyPRBack": "MyPR card (back)",
    "auth.docPassportFront": "Passport photo page",
    "auth.docPassportBack": "Passport back page",
    "auth.docIdFront": "ID document (front)",
    "auth.docIdBack": "ID document (back)",
    "auth.fieldFullName": "Full name",
    "auth.fieldPhone": "Phone number",
    "auth.fieldEmail": "Email address",
    "auth.fieldPassword": "Password",
    "auth.fieldConfirmPassword": "Confirm password",
    "auth.fieldIdNumber": "Identity number",
    "auth.fieldDateOfBirth": "Date of birth",
    "auth.fieldDateOfBirthAge": "Date of birth (must be {age}+)",
    "auth.fieldAddress": "Address",
    "auth.fieldSelfie": "Selfie",
    "auth.fieldTnC": "Terms & Conditions consent",
    "employerNav.dashboard": "Dashboard",
    "employerNav.shifts": "Shifts",
    "employerNav.postShift": "Post Shift",
    "employerNav.chat": "Chat",
    "employerNav.billing": "Billing",
    "employerNav.account": "Account",
    "employer.dashboardTitle": "Dashboard",
    "employer.goodMorning": "Good morning, ",
    "employer.statActiveShifts": "Active shifts",
    "employer.statTotalApplicants": "Total applicants",
    "employer.statFilledSlots": "Filled slots",
    "employer.statReliability": "Reliability score",
    "employer.activeShiftsHeading": "Active Shifts",
    "employer.quickActions": "Quick Actions",
    "employer.postNewShift": "+ Post New Shift",
    "employer.recentActivity": "Recent Activity",
    "employer.noActivity": "No activity yet — post a shift to start hiring.",
    "employer.shiftsTitle": "Your Shifts",
    "employer.postShiftBtn": "+ Post Shift",
    "employer.editShift": "Edit shift",
    "employer.cancelShift": "Cancel shift",
    "employer.cancellingShift": "Cancelling…",
    "employer.applicantPool": "Applicant pool",
    "employer.postAShiftTitle": "Post a Shift",
    "employer.editShiftTitle": "Edit Shift",
    "employer.postAShiftSubtitle": "Fill in shift details and required workers",
    "employer.editShiftSubtitle": "Update the details of your posted shift",
    "employer.stepShiftDetails": "Shift Details",
    "employer.stepRequirements": "Requirements",
    "employer.stepReview": "Review & Post",
    "employer.saveChanges": "Save Changes",
    "employer.publishShift": "Publish Shift",
    "employer.billingTitle": "Billing & Escrow",
    "employer.accountTitle": "Account",
    "earnings.title": "Earnings",
    "earnings.subtitle": "Live payout schedule and internal settlement status",
    "earnings.totalPayouts": "Total Internal Payouts",
    "earnings.verified": "Banking verified for salary payout",
    "earnings.notVerified": "Complete SecureSign bank verification to receive payout",
    "earnings.statRecords": "Payout records",
    "earnings.statReady": "Ready to release",
    "earnings.statHeld": "Held payouts",
    "earnings.statBanking": "Banking status",
    "earnings.recentPayouts": "Recent Payouts",
    "earnings.noPayoutsTitle": "No payouts yet",
    "earnings.noPayoutsHint": "Complete a shift and verify your bank details to receive your first payout here.",
    "earnings.salaryPayout": "salary payout",
    "settings.salaryBankingTitle": "Salary Banking Details",
    "settings.salaryBankingHint": "Mid-month payouts require verified bank details via SecureSign.",
    "settings.bankLabel": "Bank",
    "settings.accountHolderName": "Account holder name",
    "settings.accountNumber": "Account number",
    "settings.status": "Status",
    "settings.saveBanking": "Save banking",
    "settings.verifySecureSign": "Verify via SecureSign (Demo)",
  },
  bm: {
    "nav.discover": "Terokai",
    "nav.myBids": "Tawaran Saya",
    "nav.chat": "Sembang",
    "nav.earnings": "Pendapatan",
    "nav.profile": "Profil",
    "nav.settings": "Tetapan",
    "settings.title": "Tetapan",
    "settings.subtitle": "Urus akaun anda dan akses konsol tersembunyi",
    "settings.account": "Akaun",
    "settings.language": "Bahasa",
    "settings.languageEnglish": "Bahasa Inggeris",
    "settings.languageBM": "Bahasa Melayu",
    "settings.notifications": "Pemberitahuan",
    "settings.notificationsValue": "Diaktifkan",
    "settings.privacy": "Privasi",
    "settings.privacyValue": "Mod pekerja standard",
    "common.signIn": "Log Masuk",
    "common.createAccount": "Daftar Akaun",
    "common.postAShift": "Siarkan Syif",
    "common.accept": "Terima",
    "common.reject": "Tolak",
    "common.submitBid": "Hantar Tawaran →",
    "common.placeBid": "Buat Tawaran →",
    "common.signInToBid": "Log Masuk untuk Menawar →",
    "toast.avatarUpdated": "Gambar profil dikemas kini.",
    "toast.avatarUpdateFailed": "Gagal kemas kini gambar: ",
    "toast.sendFailed": "Gagal hantar: ",
    "toast.checkinSimulated": "Daftar masuk pada 18:02 · Kebolehpercayaan dikekalkan (tepat masa)",
    "toast.maxBidPrefix": "Tawaran maksimum ialah RM",
    "toast.sampleShiftBidInfo": "Ini syif contoh sahaja. Mohon syif sebenar untuk hantar tawaran.",
    "toast.applicationFailed": "Gagal hantar permohonan: ",
    "toast.signFailed": "Gagal tandatangan: ",
    "toast.contractSigned": "✅ Kontrak ditandatangani! Anda kini boleh berbual dengan majikan.",
    "toast.updateFailed": "Gagal kemas kini: ",
    "toast.escrowTopupUnavailable": "Tambah nilai escrow belum tersedia — akan datang dengan integrasi FPX/DuitNow.",
    "toast.signInToPostShift": "Log masuk untuk siarkan syif.",
    "toast.shiftFieldsRequired": "Tajuk, tarikh, dan masa mula/tamat diperlukan.",
    "toast.maxPayGteMinPay": "Gaji maksimum mesti ≥ gaji minimum.",
    "toast.postShiftFailed": "Gagal siarkan syif: ",
    "toast.shiftPublished": "Syif disiarkan! Pekerja akan mula memohon tidak lama lagi.",
    "toast.contractSent": "✅ Kontrak dihantar kepada pekerja untuk tandatangan!",
    "chat.signInTitle": "Log masuk untuk lihat mesej",
    "chat.signInHint": "Mesej dengan majikan akan muncul di sini setelah anda log masuk dan tawaran anda diterima.",
    "chat.title": "💬 Mesej",
    "chat.emptyTitleWorker": "Belum ada syif diterima.",
    "chat.emptyHintWorker": "Mesej akan muncul di sini setelah majikan menerima tawaran anda.",
    "chat.emptyTitleEmployer": "Belum ada permohonan diterima.",
    "chat.emptyHintEmployer": "Sembang akan muncul di sini setelah anda terima tawaran pekerja.",
    "chat.employerSubtitle": "Berbual dengan pekerja untuk syif yang diterima",
    "chat.loading": "Memuatkan...",
    "chat.inputPlaceholder": "Taip mesej…",
    "chat.send": "Hantar",
    "common.back": "Kembali",
    "common.cancel": "Batal",
    "shiftDetail.placeBidTitle": "Buat Tawaran Anda",
    "shiftDetail.employerRange": "Julat majikan: RM",
    "shiftDetail.maxBid": " · Tawaran maksimum: RM",
    "shiftDetail.wageAskLabel": "Kadar gaji yang anda mahu (RM/jam)",
    "shiftDetail.estimatedTotalPay": "Anggaran jumlah gaji",
    "shiftDetail.transportAllowanceSuffix": " elaun pengangkutan",
    "shiftDetail.bidSubmitted": "Tawaran Dihantar!",
    "shiftDetail.bidSubmittedHint": "Anda akan diberitahu apabila disenarai pendek",
    "shiftDetail.positions": "Kekosongan",
    "shiftDetail.applied": "Memohon",
    "shiftDetail.wageRange": "Julat Gaji",
    "shiftDetail.perHour": "sejam",
    "shiftDetail.shiftDuration": "Tempoh Syif",
    "shiftDetail.estimatedGross": "Anggaran Kasar",
    "shiftDetail.atMaxRate": "pada kadar maksimum",
    "shiftDetail.transportAllowance": "Elaun Pengangkutan",
    "shiftDetail.title": "Butiran Syif",
    "shiftDetail.aboutRole": "Tentang peranan ini",
    "shiftDetail.location": "📍 Lokasi",
    "shiftDetail.date": "🗓 Tarikh",
    "shiftDetail.time": "⏰ Masa",
    "shiftDetail.dressCode": "👗 Kod Pakaian",
    "shiftDetail.headcount": "👥 Bilangan Pekerja",
    "shiftDetail.workersNeeded": "pekerja diperlukan",
    "shiftDetail.employerScore": "🏢 Skor Majikan",
    "shiftDetail.locationNote": "Alamat sebenar akan didedahkan setelah permohonan anda diterima.",
    "shiftDetail.employerReliability": "Kebolehpercayaan Majikan",
    "shiftDetail.applicants": "pemohon",
    "profile.signInTitle": "Log masuk untuk lihat profil anda",
    "profile.signInHint": "Status KYC, skor kebolehpercayaan, penilaian, dan sejarah syif anda akan dipaparkan di sini setelah anda log masuk.",
    "profile.changePhoto": "Tukar gambar profil",
    "profile.standardKyc": "KYC Standard",
    "profile.reliabilitySuffix": "Kebolehpercayaan",
    "profile.shiftsDone": "Syif selesai",
    "profile.rating": "Penilaian",
    "profile.strikes": "Amaran",
    "profile.cleanRecord": "Rekod bersih",
    "profile.onTimeRate": "Kadar tepat masa",
    "profile.kycVerification": "Pengesahan KYC",
    "profile.kycBasic": "Asas (Telefon/E-mel)",
    "profile.kycStandard": "Standard (MyKad + Selfie)",
    "profile.kycAdvanced": "Lanjutan (Sijil)",
    "profile.verified": "✓ Disahkan",
    "profile.reliabilityScoreLabel": "Skor Kebolehpercayaan: ",
    "profile.reliabilityExcellent": "Cemerlang — 15% teratas pekerja 🏆",
    "profile.reliabilityGood": "Kedudukan baik — teruskan begini 👍",
    "profile.reliabilityBuilding": "Membina reputasi anda 📈",
    "profile.reliabilityLow": "Selesaikan lebih banyak syif untuk tingkatkan skor anda",
    "profile.recentRatings": "Penilaian Terkini",
    "profile.noRatingsTitle": "Belum ada penilaian",
    "profile.noRatingsHint": "Penilaian daripada majikan akan dipaparkan di sini selepas anda menyelesaikan syif.",
    "auth.signinSubtitle": "Gunakan e-mel dan kata laluan anda untuk mengakses CariGaji.",
    "auth.registerTitle": "Daftar",
    "auth.registerSubtitle": "Cipta akaun anda dan lengkapkan profil serta butiran KYC anda.",
    "auth.resetTitle": "Tetapkan semula kata laluan",
    "auth.resetSubtitle": "Kami akan menghantar e-mel tetapan semula kata laluan ke peti masuk anda.",
    "auth.sendResetEmail": "Hantar e-mel tetapan semula",
    "auth.emailAddress": "Alamat e-mel",
    "auth.password": "Kata laluan",
    "auth.forgetPassword": "Lupa kata laluan?",
    "auth.noAccountYet": "Belum ada akaun? Daftar Di Sini",
    "auth.resetHint": "Kami akan e-mel pautan selamat untuk tetapkan semula kata laluan anda.",
    "auth.fullName": "Nama penuh *",
    "auth.country": "Negara *",
    "auth.phoneNumber": "Nombor telefon *",
    "auth.emailAddressReq": "Alamat e-mel *",
    "auth.passwordReq": "Kata laluan *",
    "auth.createPassword": "Cipta kata laluan",
    "auth.confirmPasswordReq": "Sahkan kata laluan *",
    "auth.retypePassword": "Taip semula kata laluan anda",
    "auth.passwordsNoMatch": "Kata laluan tidak sepadan.",
    "auth.identityType": "Jenis identiti *",
    "auth.icMyKad": "IC (MyKad)",
    "auth.passport": "Pasport",
    "auth.myPR": "MyPR",
    "auth.myKadNumber": "Nombor MyKad *",
    "auth.myPRNumber": "Nombor MyPR *",
    "auth.passportNumber": "Nombor Pasport *",
    "auth.dateOfBirth": "Tarikh lahir *",
    "auth.underageWarning": "Anda mesti berumur sekurang-kurangnya {age} tahun untuk mendaftar dan bekerja di CariGaji.",
    "auth.kycLevelNote": "Tahap KYC anda akan ditetapkan berdasarkan dokumen yang dimuat naik.",
    "auth.address": "Alamat *",
    "auth.addressPlaceholder": "Jalan, bandar, negeri",
    "auth.uploadDocuments": "Muat naik dokumen",
    "auth.uploadDocumentsHint": "Muat naik gambar {doc} anda yang jelas. Nombor identiti mesti boleh dibaca dan sepadan dengan yang anda masukkan di atas.",
    "auth.passportDoc": "pasport",
    "auth.myPRCardDoc": "kad MyPR",
    "auth.myKadDoc": "MyKad",
    "auth.uploadFrontHelper": "Muat naik gambar atau PDF bahagian hadapan.",
    "auth.uploadBackHelper": "Muat naik gambar atau PDF bahagian belakang.",
    "auth.ocrChecking": "Menyemak nombor ID pada gambar anda…",
    "auth.ocrMatch": "✓ Nombor identiti pada gambar anda sepadan dengan yang anda masukkan.",
    "auth.ocrMismatchTitle": "Kami tidak dapat memadankan nombor ID pada gambar anda dengan yang anda taip.",
    "auth.ocrMismatchHint": "Ini biasanya bermaksud salah satu daripada:",
    "auth.ocrMismatchReason1": "gambar kabur atau nombor tidak kelihatan sepenuhnya,",
    "auth.ocrMismatchReason2": "nombor identiti yang anda masukkan mempunyai kesilapan taip, atau",
    "auth.ocrMismatchReason3": "gambar dokumen yang salah telah dimuat naik.",
    "auth.ocrMismatchAction": "Sila semak semula kedua-duanya. Anda masih boleh hantar — pasukan kami akan sahkan secara manual.",
    "auth.selfie": "Selfie *",
    "auth.selfieHelper": "Muat naik selfie yang jelas untuk pengesahan identiti.",
    "auth.certification": "Sijil",
    "auth.certificationHelper": "Pilihan: sijil pengendali makanan, bantuan kecemasan, atau sijil lain.",
    "auth.finalRegisterHint": "Tambah butiran peribadi dan KYC anda sekarang. Fail yang dipilih akan dimuat naik ke Supabase Storage semasa pendaftaran.",
    "auth.pleaseCompleteFields": "Sila lengkapkan medan yang ditanda:",
    "auth.docMyKadFront": "MyKad (hadapan)",
    "auth.docMyKadBack": "MyKad (belakang)",
    "auth.docMyPRFront": "Kad MyPR (hadapan)",
    "auth.docMyPRBack": "Kad MyPR (belakang)",
    "auth.docPassportFront": "Muka surat gambar pasport",
    "auth.docPassportBack": "Muka surat belakang pasport",
    "auth.docIdFront": "Dokumen identiti (hadapan)",
    "auth.docIdBack": "Dokumen identiti (belakang)",
    "auth.fieldFullName": "Nama penuh",
    "auth.fieldPhone": "Nombor telefon",
    "auth.fieldEmail": "Alamat e-mel",
    "auth.fieldPassword": "Kata laluan",
    "auth.fieldConfirmPassword": "Sahkan kata laluan",
    "auth.fieldIdNumber": "Nombor identiti",
    "auth.fieldDateOfBirth": "Tarikh lahir",
    "auth.fieldDateOfBirthAge": "Tarikh lahir (mesti {age}+)",
    "auth.fieldAddress": "Alamat",
    "auth.fieldSelfie": "Selfie",
    "auth.fieldTnC": "Persetujuan Terma & Syarat",
    "employerNav.dashboard": "Papan Pemuka",
    "employerNav.shifts": "Syif",
    "employerNav.postShift": "Siar Syif",
    "employerNav.chat": "Sembang",
    "employerNav.billing": "Bil",
    "employerNav.account": "Akaun",
    "employer.dashboardTitle": "Papan Pemuka",
    "employer.goodMorning": "Selamat pagi, ",
    "employer.statActiveShifts": "Syif aktif",
    "employer.statTotalApplicants": "Jumlah pemohon",
    "employer.statFilledSlots": "Slot terisi",
    "employer.statReliability": "Skor kebolehpercayaan",
    "employer.activeShiftsHeading": "Syif Aktif",
    "employer.quickActions": "Tindakan Pantas",
    "employer.postNewShift": "+ Siar Syif Baharu",
    "employer.recentActivity": "Aktiviti Terkini",
    "employer.noActivity": "Belum ada aktiviti — siarkan syif untuk mula mengambil pekerja.",
    "employer.shiftsTitle": "Syif Anda",
    "employer.postShiftBtn": "+ Siar Syif",
    "employer.editShift": "Sunting syif",
    "employer.cancelShift": "Batalkan syif",
    "employer.cancellingShift": "Membatalkan…",
    "employer.applicantPool": "Kumpulan Pemohon",
    "employer.postAShiftTitle": "Siar Syif",
    "employer.editShiftTitle": "Sunting Syif",
    "employer.postAShiftSubtitle": "Isikan butiran syif dan keperluan pekerja",
    "employer.editShiftSubtitle": "Kemas kini butiran syif yang telah disiarkan",
    "employer.stepShiftDetails": "Butiran Syif",
    "employer.stepRequirements": "Keperluan",
    "employer.stepReview": "Semak & Siar",
    "employer.saveChanges": "Simpan Perubahan",
    "employer.publishShift": "Siar Syif",
    "employer.billingTitle": "Bil & Escrow",
    "employer.accountTitle": "Akaun",
    "earnings.title": "Pendapatan",
    "earnings.subtitle": "Jadual bayaran langsung dan status penyelesaian dalaman",
    "earnings.totalPayouts": "Jumlah Bayaran Dalaman",
    "earnings.verified": "Perbankan disahkan untuk bayaran gaji",
    "earnings.notVerified": "Lengkapkan pengesahan bank SecureSign untuk menerima bayaran",
    "earnings.statRecords": "Rekod bayaran",
    "earnings.statReady": "Sedia dikeluarkan",
    "earnings.statHeld": "Bayaran ditahan",
    "earnings.statBanking": "Status perbankan",
    "earnings.recentPayouts": "Bayaran Terkini",
    "earnings.noPayoutsTitle": "Belum ada bayaran",
    "earnings.noPayoutsHint": "Lengkapkan satu syif dan sahkan butiran bank anda untuk menerima bayaran pertama anda di sini.",
    "earnings.salaryPayout": "bayaran gaji",
    "settings.salaryBankingTitle": "Butiran Perbankan Gaji",
    "settings.salaryBankingHint": "Bayaran pertengahan bulan memerlukan butiran bank yang disahkan melalui SecureSign.",
    "settings.bankLabel": "Bank",
    "settings.accountHolderName": "Nama pemegang akaun",
    "settings.accountNumber": "Nombor akaun",
    "settings.status": "Status",
    "settings.saveBanking": "Simpan perbankan",
    "settings.verifySecureSign": "Sahkan melalui SecureSign (Demo)",
  },
};

const MALAYSIAN_BANK_OPTIONS = [
  "Maybank",
  "CIMB",
  "Public Bank",
  "RHB",
  "Hong Leong Bank",
  "AmBank",
  "Bank Islam",
  "Bank Rakyat",
  "OCBC",
  "HSBC",
  "UOB",
];

// Hierarchical city → region mapping for location filtering.
// Keys are the canonical city names shown in the dropdown.
// Values list all sub-areas / landmarks that belong to that city.
// Matching is case-insensitive substring, so "KLCC" matches "KLCC, KL City Centre".
const CITY_REGIONS = {
  "Kuala Lumpur": [
    "kuala lumpur", "kl", "klcc", "kl city centre", "city centre",
    "bukit bintang", "chow kit", "titiwangsa", "sentul", "kepong",
    "wangsa maju", "setapak", "gombak", "batu caves", "segambut",
    "bangsar", "bangsar south", "mid valley", "pantai", "pandan",
    "ampang", "pandan indah", "pandan jaya", "ulu klang",
    "cheras", "taman connaught", "taman maluri",
    "desa petaling", "bukit jalil", "sri petaling",
    "taman tun dr ismail", "ttdi", "damansara",
    "mont kiara", "hartamas", "duta", "jalan ipoh",
    "stadium merdeka", "merdeka", "masjid india", "brickfields",
    "pudu", "imbi", "jalan raja laut", "pusat bandar",
  ],
  "Petaling Jaya": [
    "petaling jaya", "pj", "ss2", "ss3", "ss7", "damansara jaya",
    "damansara utama", "uptown", "kelana jaya", "sea park",
    "taman jaya", "ara damansara", "sunway", "bandar sunway",
    "kota damansara", "mutiara damansara", "one utama", "1 utama",
    "bandar utama", "puchong", "subang",
  ],
  "Subang Jaya": [
    "subang jaya", "subang", "ss15", "ss16", "ss18", "uep subang",
    "empire subang", "usj", "taipan", "sunway pyramid",
  ],
  "Shah Alam": [
    "shah alam", "section 14", "section 7", "section 13",
    "bukit raja", "i-city", "alam megah", "kota kemuning",
    "banting", "meru", "klang", "port klang",
  ],
  "Klang": [
    "klang", "port klang", "port swettenham", "meru klang",
    "bukit tinggi", "bandar botanik", "kapar",
  ],
  "Cheras": [
    "cheras", "taman connaught", "taman miharja", "taman mulia",
    "taman segar", "alam damai", "balakong", "kajang",
  ],
  "Kajang": [
    "kajang", "semenyih", "bangi", "nilai", "seremban",
    "bandar baru bangi", "presint bangi",
  ],
  "Putrajaya": [
    "putrajaya", "cyberjaya", "presint",
  ],
  "Penang": [
    "penang", "pulau pinang", "george town", "georgetown",
    "batu ferringhi", "tanjung bungah", "air itam", "gelugor",
    "bukit mertajam", "butterworth", "nibong tebal", "seberang jaya",
    "bayan lepas", "bayan baru", "sungai ara",
  ],
  "Johor Bahru": [
    "johor bahru", "jb", "johor", "skudai", "tebrau",
    "danga bay", "bukit indah", "mount austin", "masai",
    "pasir gudang", "kulai", "kluang", "pontian",
    "ulu tiram", "larkin", "tampoi",
  ],
  "Ipoh": [
    "ipoh", "menglembu", "bercham", "chemor", "taiping",
    "teluk intan", "lumut", "manjung",
  ],
  "Kota Kinabalu": [
    "kota kinabalu", "kk", "sabah", "penampang", "putatan",
    "inanam", "menggatal", "tuaran", "sandakan", "lahad datu", "tawau",
  ],
  "Kuching": [
    "kuching", "sarawak", "kota samarahan", "bintawa", "petra jaya",
    "miri", "sibu", "bintulu",
  ],
};

// Returns the canonical city name if the location string belongs to that city, else null.
const resolveCity = (locationStr) => {
  if (!locationStr) return null;
  const lower = locationStr.toLowerCase();
  for (const [city, regions] of Object.entries(CITY_REGIONS)) {
    if (regions.some(r => lower.includes(r))) return city;
  }
  return null;
};

// Coarse location for public listing cards — only ever a city or region,
// never the exact place/street. Prefers the canonical city; if the city is
// unknown, falls back to the last (coarsest) comma segment of the address.
const overviewLocation = (locationStr) => {
  if (!locationStr) return "Area on request";
  const city = resolveCity(locationStr);
  if (city) return city;
  const parts = locationStr.split(",").map(s => s.trim()).filter(Boolean);
  return parts[parts.length - 1] || locationStr;
};

const validateMalaysianBankAccount = (bankName, accountNumber) => {
  if (!bankName || !accountNumber) {
    return { valid: false, message: "Bank name and account number are required." };
  }
  const digits = String(accountNumber).replace(/\D/g, "");
  const code = bankName.toUpperCase().replace(/\s+/g, "_");
  const lengthMap = {
    MAYBANK: [12, 12],
    CIMB: [14, 14],
    PUBLIC_BANK: [10, 10],
    RHB: [14, 14],
    HONG_LEONG_BANK: [10, 12],
    AMBANK: [12, 14],
    BANK_ISLAM: [14, 14],
    BANK_RAKYAT: [12, 12],
    OCBC: [9, 12],
    HSBC: [12, 12],
    UOB: [10, 12],
  };
  const [min, max] = lengthMap[code] ?? [8, 17];
  if (digits.length < min || digits.length > max) {
    const range = min === max ? `${min}` : `${min}–${max}`;
    return { valid: false, message: `${bankName} account numbers must be ${range} digits (you entered ${digits.length}).` };
  }
  return { valid: true, message: "" };
};

const toCurrency = (value) => `RM ${Number(value || 0).toFixed(2)}`;

const mapVerificationPillColor = (status) => {
  if (status === "verified") return "green";
  if (status === "rejected") return "red";
  return "amber";
};

const mapPayoutPillColor = (status) => {
  if (status === "processed_internal") return "green";
  if (status === "held" || status === "failed_internal") return "red";
  if (["ready", "scheduled", "processing"].includes(status)) return "blue";
  return "gray";
};

// ─── Language / i18n ────────────────────────────────────────────────────────
const LANGUAGE_STORAGE_KEY = "carigaji_lang";

const readLanguagePreference = () => {
  if (typeof window === "undefined") return "en";
  const stored = window.localStorage.getItem(LANGUAGE_STORAGE_KEY);
  return stored === "bm" ? "bm" : "en";
};

const LanguageContext = createContext({ language: "en", setLanguage: () => {}, t: (key) => key });
const useLanguage = () => useContext(LanguageContext);

const LanguageProvider = ({ children }) => {
  const [language, setLanguageState] = useState(() => readLanguagePreference());

  const setLanguage = useCallback((lang) => {
    const next = lang === "bm" ? "bm" : "en";
    setLanguageState(next);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(LANGUAGE_STORAGE_KEY, next);
    }
  }, []);

  const t = useCallback((key) => (TRANSLATIONS[language]?.[key] ?? TRANSLATIONS.en[key] ?? key), [language]);

  const value = useMemo(() => ({ language, setLanguage, t }), [language, setLanguage, t]);

  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>;
};

// ─── Toast system ───────────────────────────────────────────────────────────
const ToastContext = createContext(() => {});
const useToast = () => useContext(ToastContext);

const TOAST_ACCENT = {
  success: "var(--cg-toast-success, #1A9E5C)",
  error: "#DC2626",
  info: "#2563EB",
};

const ToastProvider = ({ children }) => {
  const [toasts, setToasts] = useState([]);

  const dismiss = useCallback((id) => {
    setToasts((list) => list.filter((t) => t.id !== id));
  }, []);

  const showToast = useCallback((message, type = "info", duration = 4000) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    setToasts((list) => [...list, { id, message, type }]);
    if (duration > 0) setTimeout(() => dismiss(id), duration);
    return id;
  }, [dismiss]);

  return (
    <ToastContext.Provider value={showToast}>
      {children}
      <div
        role="status"
        aria-live="polite"
        style={{
          position: "fixed",
          left: "50%",
          bottom: "calc(24px + env(safe-area-inset-bottom, 0px))",
          transform: "translateX(-50%)",
          zIndex: 1000,
          display: "flex",
          flexDirection: "column",
          gap: 10,
          width: "min(420px, calc(100% - 32px))",
          pointerEvents: "none",
        }}
      >
        {toasts.map((t) => (
          <div
            key={t.id}
            onClick={() => dismiss(t.id)}
            style={{
              pointerEvents: "auto",
              cursor: "pointer",
              background: "var(--cg-surface, #fff)",
              color: "var(--cg-text, #111827)",
              border: "1px solid var(--cg-border, #E5E7EB)",
              borderLeft: `4px solid ${TOAST_ACCENT[t.type] || TOAST_ACCENT.info}`,
              borderRadius: 12,
              padding: "12px 16px",
              fontSize: 14,
              lineHeight: 1.45,
              fontWeight: 500,
              boxShadow: "0 8px 28px var(--cg-shadow, rgba(15,23,42,0.12))",
              whiteSpace: "pre-line",
              animation: "cg-toast-in 0.18s ease-out",
            }}
          >
            {t.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
};

// ─── Shared helpers ─────────────────────────────────────────────────────────
const Badge = memo(({ color = "gray", children, size = "sm" }) => {
  const map = {
    gray: { bg: BRAND.grayLight, text: BRAND.textMuted },
    green: { bg: BRAND.greenLight, text: "#065F46" },
    red: { bg: BRAND.redLight, text: "#991B1B" },
    amber: { bg: BRAND.amberLight, text: "#92400E" },
    blue: { bg: BRAND.blueLight, text: "#1E40AF" },
    orange: { bg: BRAND.accentLight, text: "#155E75" },
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
});

const Card = memo(({ children, style = {}, onClick, hover = false }) => (
  <div onClick={onClick} style={{
    background: BRAND.surface,
    border: `1px solid ${BRAND.border}`,
    borderRadius: 16,
    padding: "20px 24px",
    cursor: onClick ? "pointer" : "default",
    transition: "box-shadow 0.15s, transform 0.15s",
    ...style,
  }}
    onMouseEnter={e => { if (hover || onClick) { e.currentTarget.style.boxShadow = `0 4px 20px ${BRAND.shadow}`; e.currentTarget.style.transform = "translateY(-1px)"; } }}
    onMouseLeave={e => { e.currentTarget.style.boxShadow = "none"; e.currentTarget.style.transform = "none"; }}
  >{children}</div>
));

const Btn = memo(({ children, variant = "primary", onClick, size = "md", style = {}, disabled = false, type = "button", ...rest }) => {
  const base = {
    display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6,
    border: "none", borderRadius: 10, cursor: disabled ? "not-allowed" : "pointer",
    fontWeight: 600, fontFamily: "inherit",
    transition: "all 0.15s", opacity: disabled ? 0.5 : 1,
    minHeight: size === "xs" ? 28 : 36,
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
    <button type={type} onClick={disabled ? undefined : onClick} disabled={disabled} style={{ ...base, ...variants[variant], ...style }}
      onMouseEnter={e => { if (!disabled) e.currentTarget.style.opacity = "0.85"; }}
      onMouseLeave={e => { e.currentTarget.style.opacity = "1"; }}
      {...rest}
    >{children}</button>
  );
});

const Avatar = memo(({ name = "?", size = 36, color = BRAND.primary, src = null }) => {
  const initials = name.split(" ").map(w => w[0]).slice(0, 2).join("").toUpperCase();
  if (src) {
    return (
      <img
        src={src}
        alt={name}
        style={{
          width: size, height: size, borderRadius: "50%",
          objectFit: "cover", flexShrink: 0, display: "block",
          background: color + "22",
        }}
      />
    );
  }
  return (
    <div style={{
      width: size, height: size, borderRadius: "50%",
      background: color + "22", color: color,
      display: "flex", alignItems: "center", justifyContent: "center",
      fontSize: size * 0.35, fontWeight: 700, flexShrink: 0,
    }}>{initials}</div>
  );
});

const Stat = memo(({ label, value, sub, color = BRAND.primary }) => (
  <div style={{ background: BRAND.grayLight, borderRadius: 14, padding: "16px 20px" }}>
    <div style={{ fontSize: 12, color: BRAND.textMuted, fontWeight: 500, marginBottom: 4 }}>{label}</div>
    <div style={{ fontSize: 26, fontWeight: 800, color, lineHeight: 1 }}>{value}</div>
    {sub && <div style={{ fontSize: 11, color: BRAND.textMuted, marginTop: 4 }}>{sub}</div>}
  </div>
));

const Input = ({ label, placeholder, value, onChange, type = "text", style = {}, error = false, ...rest }) => (
  <div style={{ marginBottom: 16, ...style }}>
    {label && <label style={{ display: "block", fontSize: 13, fontWeight: 600, color: error ? BRAND.red : BRAND.text, marginBottom: 6 }}>{label}</label>}
    <input type={type} placeholder={placeholder} value={value} onChange={onChange} {...rest}
      style={{
        width: "100%", padding: "10px 14px", borderRadius: 10,
        border: `1.5px solid ${error ? BRAND.red : BRAND.border}`, fontSize: 14, fontFamily: "inherit",
        color: BRAND.text, background: BRAND.input, outline: "none",
        boxSizing: "border-box",
      }}
    />
  </div>
);

// Loads the Google Maps JS API (Places library) once, on demand.
const loadGoogleMaps = (() => {
  let promise = null;
  return (apiKey) => {
    if (typeof window === "undefined") return Promise.reject(new Error("no window"));
    if (window.google?.maps?.places) return Promise.resolve(window.google);
    if (promise) return promise;
    promise = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = `https://maps.googleapis.com/maps/api/js?key=${apiKey}&libraries=places`;
      s.async = true;
      s.defer = true;
      s.onload = () => (window.google?.maps?.places ? resolve(window.google) : reject(new Error("places missing")));
      s.onerror = () => reject(new Error("maps script failed"));
      document.head.appendChild(s);
    });
    return promise;
  };
})();

// Location field with Google Places autocomplete (Malaysia-restricted).
// Falls back to a plain text input when no API key is configured.
const LocationAutocomplete = ({ label = "Location", value, onChange, error = false }) => {
  const apiKey = import.meta.env.VITE_GOOGLE_MAPS_API_KEY;
  const inputRef = useRef(null);
  useEffect(() => {
    if (!apiKey || !inputRef.current) return;
    let cancelled = false;
    let listener = null;
    loadGoogleMaps(apiKey).then(google => {
      if (cancelled || !inputRef.current) return;
      const ac = new google.maps.places.Autocomplete(inputRef.current, {
        componentRestrictions: { country: "my" },
        fields: ["formatted_address", "name"],
      });
      listener = ac.addListener("place_changed", () => {
        const place = ac.getPlace();
        onChange(place.formatted_address || place.name || inputRef.current.value);
      });
    }).catch(() => {}); // silent fallback to manual typing
    return () => { cancelled = true; if (listener) listener.remove(); };
  }, [apiKey]);
  return (
    <div style={{ marginBottom: 16 }}>
      {label && <label style={{ display: "block", fontSize: 13, fontWeight: 600, color: error ? BRAND.red : BRAND.text, marginBottom: 6 }}>{label}</label>}
      <input
        ref={inputRef}
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={apiKey ? "Start typing an address or place…" : "e.g. KLCC, Kuala Lumpur"}
        style={{
          width: "100%", padding: "10px 14px", borderRadius: 10,
          border: `1.5px solid ${error ? BRAND.red : BRAND.border}`, fontSize: 14, fontFamily: "inherit",
          color: BRAND.text, background: BRAND.input, outline: "none", boxSizing: "border-box",
        }}
      />
    </div>
  );
};

const PasswordInput = ({ label, placeholder, value, onChange, style = {}, hideToggle = false, error = false }) => {
  const [show, setShow] = useState(false);
  return (
    <div style={{ marginBottom: 16, position: "relative", ...style }}>
      {label && <label style={{ display: "block", fontSize: 13, fontWeight: 600, color: error ? BRAND.red : BRAND.text, marginBottom: 6 }}>{label}</label>}
      <div style={{ position: "relative" }}>
        <input
          type={show ? "text" : "password"}
          placeholder={placeholder}
          value={value}
          onChange={onChange}
          style={{
            width: "100%", padding: "10px 14px", borderRadius: 10,
            border: `1.5px solid ${error ? BRAND.red : BRAND.border}`, fontSize: 14, fontFamily: "inherit",
            color: BRAND.text, background: BRAND.input, outline: "none",
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

const FileInput = ({ label, onChange, accept, helper, fileName, error = false }) => (
  <div style={{ marginBottom: 16 }}>
    {label && <label style={{ display: "block", fontSize: 13, fontWeight: 600, color: error ? BRAND.red : BRAND.text, marginBottom: 6 }}>{label}</label>}
    <input
      type="file"
      accept={accept}
      onChange={onChange}
      style={{
        width: "100%",
        padding: "10px 14px",
        borderRadius: 10,
        border: `1.5px solid ${error ? BRAND.red : BRAND.border}`,
        fontSize: 14,
        fontFamily: "inherit",
        color: BRAND.text,
        background: BRAND.input,
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
      color: BRAND.text, background: BRAND.input, outline: "none",
    }}>
      {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  </div>
);

const Pill = memo(({ label, color }) => (
  <span style={{
    display: "inline-block", padding: "3px 10px", borderRadius: 99,
    fontSize: 12, fontWeight: 600,
    background: color === "green" ? BRAND.greenLight : color === "red" ? BRAND.redLight : color === "amber" ? BRAND.amberLight : color === "blue" ? BRAND.blueLight : BRAND.grayLight,
    color: color === "green" ? "#065F46" : color === "red" ? "#991B1B" : color === "amber" ? "#92400E" : color === "blue" ? "#1E40AF" : BRAND.textMuted,
  }}>{label}</span>
));

const EmptyState = memo(({ icon = "📭", title, hint }) => (
  <div style={{
    border: `1px dashed ${BRAND.border}`,
    borderRadius: 14,
    padding: "28px 20px",
    textAlign: "center",
    background: BRAND.grayLight,
  }}>
    <div style={{ fontSize: 28, marginBottom: 8 }} aria-hidden="true">{icon}</div>
    <div style={{ fontSize: 14, fontWeight: 700, color: BRAND.text, marginBottom: 4 }}>{title}</div>
    {hint && <div style={{ fontSize: 12, color: BRAND.textMuted, lineHeight: 1.5 }}>{hint}</div>}
  </div>
));

const AuthGate = memo(({ onRequireAuth, title, hint, icon = "🔒" }) => {
  const { t } = useLanguage();
  return (
  <div style={{
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    textAlign: "center",
    gap: 14,
    padding: "48px 24px",
  }}>
    <div style={{
      width: 64, height: 64, borderRadius: "50%",
      background: BRAND.primaryLight, display: "flex",
      alignItems: "center", justifyContent: "center", fontSize: 28,
    }} aria-hidden="true">{icon}</div>
    <div>
      <div style={{ fontSize: 18, fontWeight: 800, color: BRAND.text, marginBottom: 6 }}>{title}</div>
      <div style={{ fontSize: 13, color: BRAND.textMuted, lineHeight: 1.5, maxWidth: 280 }}>{hint}</div>
    </div>
    <div style={{ display: "flex", gap: 10, marginTop: 4, width: "100%", maxWidth: 280 }}>
      <Btn variant="secondary" onClick={() => onRequireAuth("register")} style={{ flex: 1, justifyContent: "center" }}>{t("common.createAccount")}</Btn>
      <Btn onClick={() => onRequireAuth("signin")} style={{ flex: 1, justifyContent: "center" }}>{t("common.signIn")}</Btn>
    </div>
  </div>
  );
});

const SkeletonRow = memo(({ height = 64 }) => (
  <div style={{
    height,
    borderRadius: 14,
    marginBottom: 10,
    background: `linear-gradient(90deg, ${BRAND.grayLight} 25%, ${BRAND.border} 37%, ${BRAND.grayLight} 63%)`,
    backgroundSize: "400% 100%",
    animation: "cg-skeleton 1.3s ease-in-out infinite",
  }} />
));

const ProfileMenu = ({ user, onSignOut }) => {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const handleClick = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  const displayName = user.user_metadata?.full_name || user.email?.split("@")[0] || "Account";
  const avatarUrl = getAvatarUrl(user.user_metadata?.avatar_url);

  const items = [
    { label: "Help", icon: "❓", onClick: () => toast("Help centre is coming soon.", "info") },
    { label: "Contact customer support", icon: "💬", onClick: () => toast("Support: support@carigaji.com", "info", 6000) },
    { label: "Refer friends", icon: "🎁", onClick: () => toast("Referral programme launching soon.", "info") },
    { label: "Sign out", icon: "↩️", danger: true, onClick: onSignOut },
  ];

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Account menu"
        style={{
          display: "flex", alignItems: "center", gap: 8, cursor: "pointer",
          border: `1px solid ${BRAND.border}`, background: BRAND.surface,
          borderRadius: 99, padding: "4px 10px 4px 4px", fontFamily: "inherit",
        }}
      >
        <Avatar name={displayName} size={32} color={BRAND.primary} src={avatarUrl} />
        <span style={{ fontSize: 13, fontWeight: 600, color: BRAND.text, maxWidth: 120, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{displayName}</span>
        <span aria-hidden="true" style={{ fontSize: 10, color: BRAND.textMuted }}>▼</span>
      </button>
      {open && (
        <div role="menu" style={{
          position: "absolute", right: 0, top: "calc(100% + 8px)", zIndex: 400,
          minWidth: 220, background: BRAND.surface, border: `1px solid ${BRAND.border}`,
          borderRadius: 12, boxShadow: `0 12px 40px ${BRAND.shadow}`, overflow: "hidden",
        }}>
          <div style={{ padding: "12px 14px", borderBottom: `1px solid ${BRAND.border}` }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: BRAND.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{displayName}</div>
            <div style={{ fontSize: 11, color: BRAND.textMuted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{user.email}</div>
          </div>
          {items.map((it) => (
            <button
              key={it.label}
              role="menuitem"
              onClick={() => { setOpen(false); it.onClick(); }}
              style={{
                width: "100%", display: "flex", alignItems: "center", gap: 10,
                padding: "10px 14px", border: "none", background: "transparent",
                cursor: "pointer", fontFamily: "inherit", fontSize: 13, textAlign: "left",
                color: it.danger ? BRAND.red : BRAND.text,
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = BRAND.grayLight; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
            >
              <span aria-hidden="true" style={{ fontSize: 15 }}>{it.icon}</span>
              <span>{it.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

const notificationTimeAgo = (iso) => {
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString("en-MY");
};

const NotificationBell = ({ user }) => {
  const [notifications, setNotifications] = useState([]);
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  const unreadCount = notifications.filter((n) => !n.read).length;

  useEffect(() => {
    if (!open) return undefined;
    const handleClick = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  useEffect(() => {
    if (!user?.id) return undefined;
    let active = true;
    supabase
      .from('notifications')
      .select('*')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })
      .limit(20)
      .then(({ data }) => {
        if (active) setNotifications(data ?? []);
      });
    const channel = supabase
      .channel(`notifications-${user.id}`)
      .on('postgres_changes', {
        event: 'INSERT',
        schema: 'public',
        table: 'notifications',
        filter: `user_id=eq.${user.id}`,
      }, payload => {
        if (active) setNotifications(prev => [payload.new, ...prev]);
      })
      .subscribe();
    return () => {
      active = false;
      supabase.removeChannel(channel);
    };
  }, [user?.id]);

  const markRead = async (id) => {
    setNotifications(prev => prev.map(n => (n.id === id ? { ...n, read: true } : n)));
    await supabase.from('notifications').update({ read: true }).eq('id', id);
  };

  const markAllRead = async () => {
    const unreadIds = notifications.filter((n) => !n.read).map((n) => n.id);
    if (unreadIds.length === 0) return;
    setNotifications(prev => prev.map(n => ({ ...n, read: true })));
    await supabase.from('notifications').update({ read: true }).in('id', unreadIds);
  };

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Notifications"
        style={{
          position: "relative", display: "flex", alignItems: "center", justifyContent: "center",
          width: 36, height: 36, cursor: "pointer",
          border: `1px solid ${BRAND.border}`, background: BRAND.surface,
          borderRadius: 99, padding: 0, fontFamily: "inherit", fontSize: 16,
        }}
      >
        <span aria-hidden="true">🔔</span>
        {unreadCount > 0 && (
          <span aria-hidden="true" style={{
            position: "absolute", top: -4, right: -4, minWidth: 16, height: 16, padding: "0 3px",
            borderRadius: 99, background: BRAND.red, color: "#fff", fontSize: 10, fontWeight: 700,
            display: "flex", alignItems: "center", justifyContent: "center", lineHeight: 1,
          }}>
            {unreadCount > 9 ? "9+" : unreadCount}
          </span>
        )}
      </button>
      {open && (
        <div role="menu" style={{
          position: "absolute", right: 0, top: "calc(100% + 8px)", zIndex: 400,
          width: 320, maxWidth: "90vw", background: BRAND.surface, border: `1px solid ${BRAND.border}`,
          borderRadius: 12, boxShadow: `0 12px 40px ${BRAND.shadow}`, overflow: "hidden",
        }}>
          <div style={{
            display: "flex", alignItems: "center", justifyContent: "space-between",
            padding: "12px 14px", borderBottom: `1px solid ${BRAND.border}`,
          }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: BRAND.text }}>Notifications</div>
            {unreadCount > 0 && (
              <button
                onClick={markAllRead}
                style={{
                  border: "none", background: "transparent", cursor: "pointer", fontFamily: "inherit",
                  fontSize: 11, fontWeight: 600, color: BRAND.primary, padding: 0,
                }}
              >
                Mark all as read
              </button>
            )}
          </div>
          <div style={{ maxHeight: 360, overflowY: "auto" }}>
            {notifications.length === 0 ? (
              <div style={{ padding: "24px 14px", textAlign: "center", fontSize: 12, color: BRAND.textMuted }}>
                No notifications yet
              </div>
            ) : (
              notifications.map((n) => (
                <button
                  key={n.id}
                  role="menuitem"
                  onClick={() => markRead(n.id)}
                  style={{
                    width: "100%", display: "flex", alignItems: "flex-start", gap: 8,
                    padding: "10px 14px", border: "none", borderBottom: `1px solid ${BRAND.border}`,
                    background: n.read ? "transparent" : BRAND.grayLight,
                    cursor: "pointer", fontFamily: "inherit", textAlign: "left",
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = BRAND.grayLight; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = n.read ? "transparent" : BRAND.grayLight; }}
                >
                  {!n.read && (
                    <span aria-hidden="true" style={{
                      width: 7, height: 7, borderRadius: 99, background: BRAND.primary,
                      marginTop: 5, flexShrink: 0,
                    }} />
                  )}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12.5, fontWeight: 700, color: BRAND.text }}>{n.title}</div>
                    {n.body && (
                      <div style={{ fontSize: 11.5, color: BRAND.textMuted, marginTop: 2, lineHeight: 1.4 }}>{n.body}</div>
                    )}
                    <div style={{ fontSize: 10.5, color: BRAND.textMuted, marginTop: 4 }}>{notificationTimeAgo(n.created_at)}</div>
                  </div>
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
};

const StarRating = ({ value = 4.5, size = 14 }) => {
  const stars = [];
  for (let i = 1; i <= 5; i++) {
    stars.push(
      <span key={i} style={{ color: i <= Math.round(value) ? BRAND.accent : BRAND.border, fontSize: size }}>
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style={{ display: "inline-block", verticalAlign: "middle" }}>
          <path d="M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z" fill={i <= Math.round(value) ? BRAND.accent : BRAND.border} />
        </svg>
      </span>
    );
  }
  return <span>{stars} <span style={{ fontSize: size - 2, color: BRAND.textMuted }}>({value})</span></span>;
};

// Vertical scroll-snap number picker for choosing an hourly bid rate.
// Renders every RM value from `min` to `max` (inclusive) and reports the
// value nearest the centre as the user scrolls, like an iOS picker wheel.
const WageRatePicker = ({ min, max, value, onChange, step = 1 }) => {
  const containerRef = useRef(null);
  const ITEM_H = 40;
  const VISIBLE = 3; // odd number so one item sits centred
  const values = useMemo(() => {
    const out = [];
    for (let v = Math.ceil(min); v <= Math.floor(max); v += step) out.push(v);
    if (out.length === 0) out.push(Math.round(min));
    return out;
  }, [min, max, step]);

  // Scroll to the current value whenever the picker mounts or the value is
  // set externally (e.g. modal reopened).
  useEffect(() => {
    if (!containerRef.current) return;
    const idx = Math.max(0, values.indexOf(Number(value)));
    containerRef.current.scrollTop = idx * ITEM_H;
  }, [values]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleScroll = () => {
    if (!containerRef.current) return;
    const idx = Math.round(containerRef.current.scrollTop / ITEM_H);
    const clamped = Math.min(values.length - 1, Math.max(0, idx));
    const v = values[clamped];
    if (v !== undefined && v !== Number(value)) onChange(v);
  };

  const padding = (ITEM_H * (VISIBLE - 1)) / 2;

  return (
    <div style={{ position: "relative", height: ITEM_H * VISIBLE }}>
      {/* Centre selection band — solid fill + white text so the selected
          value stays readable regardless of light/dark theme (a pale
          tinted band with coloured text was too low-contrast). */}
      <div style={{
        position: "absolute", top: padding, left: 0, right: 0, height: ITEM_H,
        background: BRAND.primary, borderRadius: 10, pointerEvents: "none",
        zIndex: 1,
      }} />
      <div
        ref={containerRef}
        onScroll={handleScroll}
        style={{
          position: "relative", zIndex: 2,
          height: "100%", overflowY: "auto", scrollSnapType: "y mandatory",
          WebkitOverflowScrolling: "touch", scrollbarWidth: "none",
        }}
      >
        <div style={{ height: padding }} />
        {values.map(v => (
          <div
            key={v}
            onClick={() => { onChange(v); if (containerRef.current) containerRef.current.scrollTop = values.indexOf(v) * ITEM_H; }}
            style={{
              height: ITEM_H, scrollSnapAlign: "center", display: "flex", alignItems: "center",
              justifyContent: "center", fontSize: v === Number(value) ? 20 : 15,
              fontWeight: v === Number(value) ? 800 : 500,
              color: v === Number(value) ? "#FFFFFF" : BRAND.textMuted,
              cursor: "pointer", transition: "font-size 0.1s, color 0.1s",
            }}
          >
            RM{v}/h
          </div>
        ))}
        <div style={{ height: padding }} />
      </div>
    </div>
  );
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
      <circle cx="12" cy="12" r="3" stroke="#374151" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" stroke="#374151" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
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
  Edit: ({ size = 18 }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M12 20h9" stroke="#374151" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z" stroke="#374151" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  Chat: ({ size = 18 }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" stroke="#374151" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
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
  <div style={{ height: 6, background: BRAND.grayLight, borderRadius: 99, overflow: "hidden" }}>
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
  if ((hasFront || hasBack) && hasSelfie) return "pending_review";
  if (hasSupportingDoc && hasSelfie) return "pending_review";
  return "Basic";
};

const KYC_BUCKET = "kyc-documents";
const AVATAR_BUCKET = "avatars";

// Downscale + re-encode images client-side before upload to cut storage cost.
const compressImage = (file, maxDim = 1280, quality = 0.82) =>
  new Promise((resolve) => {
    if (!file || !file.type?.startsWith("image/")) return resolve(file);
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      let { width, height } = img;
      if (width > maxDim || height > maxDim) {
        if (width >= height) { height = Math.round((height * maxDim) / width); width = maxDim; }
        else { width = Math.round((width * maxDim) / height); height = maxDim; }
      }
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      canvas.getContext("2d").drawImage(img, 0, 0, width, height);
      canvas.toBlob(
        (blob) => {
          if (!blob) return resolve(file);
          resolve(new File([blob], file.name.replace(/\.\w+$/, ".jpg"), { type: "image/jpeg" }));
        },
        "image/jpeg",
        quality
      );
    };
    img.onerror = () => { URL.revokeObjectURL(url); resolve(file); };
    img.src = url;
  });

const getAvatarUrl = (path) => {
  if (!path) return null;
  if (path.startsWith("http")) return path;
  const { data } = supabase.storage.from(AVATAR_BUCKET).getPublicUrl(path);
  return data?.publicUrl || null;
};

const uploadAvatarFile = async (userId, file) => {
  if (!file) return null;
  const compressed = await compressImage(file, 512, 0.85);
  const path = `${userId}/avatar.jpg`;
  const { error } = await supabase.storage.from(AVATAR_BUCKET).upload(path, compressed, {
    contentType: "image/jpeg",
    upsert: true,
  });
  if (error) throw error;
  return path;
};

const uploadKycFile = async (userId, file, label) => {
  if (!file) return null;
  // Compress photos (keep legibility for ID docs); leave PDFs/others untouched.
  const toUpload = file.type?.startsWith("image/") ? await compressImage(file, 1600, 0.8) : file;
  const safeName = toUpload.name.replace(/[^a-zA-Z0-9._-]/g, "_");
  const path = `${userId}/${Date.now()}-${label}-${safeName}`;
  const { error } = await supabase.storage.from(KYC_BUCKET).upload(path, toUpload, {
    contentType: toUpload.type || "application/octet-stream",
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
            background: BRAND.input,
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
            background: BRAND.surface,
            border: `1px solid ${BRAND.border}`,
            borderRadius: 10,
            boxShadow: `0 4px 12px ${BRAND.shadow}`,
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

const TnCConsent = ({ checked, onChange, error = false }) => {
  const [expanded, setExpanded] = useState(false);
  return (
    <div style={{ marginBottom: 16, ...(error ? { border: `1.5px solid ${BRAND.red}`, borderRadius: 10, padding: 10 } : {}) }}>
      <label style={{ display: "flex", alignItems: "flex-start", gap: 10, cursor: "pointer" }}>
        <input
          type="checkbox"
          checked={checked}
          onChange={e => onChange(e.target.checked)}
          style={{ marginTop: 2, accentColor: BRAND.primary, flexShrink: 0, width: 16, height: 16 }}
        />
        <span style={{ fontSize: 12, color: error ? BRAND.red : BRAND.text, lineHeight: 1.5 }}>
          I have read and agree to the{" "}
          <span
            role="button"
            tabIndex={0}
            onClick={e => { e.preventDefault(); setExpanded(v => !v); }}
            onKeyDown={e => e.key === "Enter" && setExpanded(v => !v)}
            style={{ color: BRAND.primary, textDecoration: "underline", cursor: "pointer" }}
          >
            Terms & Conditions and Privacy Notice
          </span>
          , including the collection and use of my identity document (MyKad/passport) for employment verification purposes.
        </span>
      </label>
      {expanded && (
        <div style={{ marginTop: 10, padding: "12px 14px", background: "#F8FAFC", borderRadius: 8, border: "1px solid #E2E8F0", fontSize: 11.5, color: BRAND.textMuted, lineHeight: 1.7 }}>
          <strong style={{ color: BRAND.text, fontSize: 12 }}>Privacy Notice & Terms of Consent</strong>
          <p style={{ marginTop: 8 }}>
            <strong>1. Data Controller</strong><br />
            CariGaji ("we", "us") operates this platform and is responsible for the personal data you provide during registration. This notice is issued pursuant to the <strong>Personal Data Protection Act 2010 (Act 709)</strong> ("PDPA").
          </p>
          <p>
            <strong>2. Personal Data Collected</strong><br />
            We collect your full name, national identity card number (MyKad) or passport number, date of birth, residential address, phone number, email address, selfie photograph, and copies of your identity document (front and back). This information is required to complete your account registration and KYC (Know Your Customer) verification.
          </p>
          <p>
            <strong>3. Purpose of Collection</strong><br />
            Your personal data and identity document are collected solely for the following purposes:
          </p>
          <ul style={{ paddingLeft: 16, margin: "4px 0 8px" }}>
            <li>Verifying your identity on the CariGaji platform as permitted under the <strong>National Registration Act 1959 (Act 78)</strong>;</li>
            <li>Sharing your identity information with employers who have engaged you for a shift, to enable them to fulfil their statutory record-keeping obligations under the <strong>Employment Act 1955 (Act 265)</strong> and the <strong>Gig Workers Act 2025 (Act 872)</strong>;</li>
            <li>Complying with applicable laws and regulatory requirements.</li>
          </ul>
          <p>
            <strong>4. Disclosure of Personal Data</strong><br />
            Your personal data will only be shared with (a) employers on this platform who have confirmed your engagement for a shift, and (b) relevant government authorities where required by law. We will not sell, rent, or otherwise disclose your data to any third party for marketing purposes.
          </p>
          <p>
            <strong>5. Data Retention</strong><br />
            Your personal data will be retained for as long as your account remains active and for a minimum of seven (7) years after your last transaction to meet legal and audit obligations. You may request deletion of your account; however, retention for statutory compliance purposes may continue where required by law.
          </p>
          <p>
            <strong>6. Your Rights Under PDPA</strong><br />
            You have the right to access, correct, and request the deletion of your personal data held by us. To exercise these rights, please contact us at <strong>support@carigaji.my</strong>. We will respond within fourteen (14) business days.
          </p>
          <p>
            <strong>7. Consent</strong><br />
            By ticking the checkbox, you confirm that you are at least 18 years of age (or have obtained parental/guardian consent), that the information you provide is accurate, and that you voluntarily consent to the collection, processing, and disclosure of your personal data as described above. You acknowledge that providing false identity documents may constitute an offence under Malaysian law.
          </p>
          <p style={{ marginBottom: 0 }}>
            <strong>8. Withdrawal of Consent</strong><br />
            You may withdraw this consent at any time by contacting us, but doing so may limit or terminate your access to the platform.
          </p>
        </div>
      )}
    </div>
  );
};

const SocialAuthButtons = ({ onOAuth, label = "Continue" }) => {
  const providers = [
    {
      id: "google", name: "Google",
      icon: (
        <svg width="18" height="18" viewBox="0 0 18 18" xmlns="http://www.w3.org/2000/svg">
          <path d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92a8.78 8.78 0 0 0 2.68-6.62z" fill="#4285F4"/>
          <path d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18z" fill="#34A853"/>
          <path d="M3.97 10.72a5.4 5.4 0 0 1 0-3.44V4.95H.96a9 9 0 0 0 0 8.1l3.01-2.33z" fill="#FBBC05"/>
          <path d="M9 3.58c1.32 0 2.5.46 3.44 1.35l2.58-2.58A8.98 8.98 0 0 0 9 0 9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58z" fill="#EA4335"/>
        </svg>
      ),
    },
    {
      id: "apple", name: "Apple",
      icon: (
        <svg width="16" height="18" viewBox="0 0 16 18" xmlns="http://www.w3.org/2000/svg" fill="#000">
          <path d="M13.24 9.54c-.02-2.02 1.65-2.99 1.72-3.04-.94-1.37-2.4-1.56-2.92-1.58-1.24-.13-2.42.73-3.05.73-.63 0-1.6-.71-2.63-.69-1.35.02-2.6.79-3.3 2-1.4 2.44-.36 6.05 1.01 8.03.67.97 1.47 2.06 2.5 2.02 1-.04 1.39-.65 2.6-.65 1.21 0 1.56.65 2.63.63 1.09-.02 1.78-.99 2.44-1.96.77-1.12 1.09-2.21 1.1-2.27-.02-.01-2.11-.81-2.13-3.21zM11.3 3.6c.55-.67.93-1.6.82-2.53-.8.03-1.76.53-2.33 1.2-.51.59-.96 1.53-.84 2.44.89.07 1.8-.45 2.35-1.11z"/>
        </svg>
      ),
    },
    {
      id: "facebook", name: "Facebook",
      icon: (
        <svg width="18" height="18" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" fill="#1877F2">
          <path d="M24 12c0-6.63-5.37-12-12-12S0 5.37 0 12c0 5.99 4.39 10.95 10.13 11.85v-8.38H7.08V12h3.05V9.36c0-3.01 1.79-4.67 4.53-4.67 1.31 0 2.68.23 2.68.23v2.95h-1.51c-1.49 0-1.96.93-1.96 1.87V12h3.33l-.53 3.47h-2.8v8.38C19.61 22.95 24 17.99 24 12z"/>
        </svg>
      ),
    },
  ];
  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, margin: "4px 0 14px" }}>
        <div style={{ flex: 1, height: 1, background: BRAND.border }} />
        <span style={{ fontSize: 12, color: BRAND.textMuted }}>or</span>
        <div style={{ flex: 1, height: 1, background: BRAND.border }} />
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {providers.map(p => (
          <button
            key={p.id}
            type="button"
            onClick={() => onOAuth?.(p.id)}
            style={{
              display: "flex", alignItems: "center", justifyContent: "center", gap: 10,
              width: "100%", padding: "10px 14px", borderRadius: 10,
              border: `1px solid ${BRAND.border}`, background: BRAND.surface,
              color: BRAND.text, fontSize: 14, fontWeight: 600, fontFamily: "inherit",
              cursor: "pointer",
            }}
          >
            {p.icon}
            <span>{label} with {p.name}</span>
          </button>
        ))}
      </div>
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
  onOAuth,
}) => {
  const { t: translate } = useLanguage();
  const [showErrors, setShowErrors] = useState(false);
  // Advisory OCR check that the ID on the uploaded photo matches what was typed.
  // status: idle | checking | match | mismatch | unreadable
  const [idOcr, setIdOcr] = useState({ status: "idle" });
  const scrollRef = useRef(null);
  // Keep the status message visible without forcing the user to scroll up
  useEffect(() => {
    if (message && scrollRef.current) scrollRef.current.scrollTo({ top: 0, behavior: "smooth" });
  }, [message]);
  useEffect(() => { setShowErrors(false); }, [view, open]);

  const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email || "");

  // Legal working age gate — Malaysia; platform T&C requires 18+.
  const LEGAL_WORKING_AGE = 18;
  const ageFromDob = dob => {
    if (!dob) return null;
    const d = new Date(dob);
    if (isNaN(d)) return null;
    const t = new Date();
    let a = t.getFullYear() - d.getFullYear();
    const m = t.getMonth() - d.getMonth();
    if (m < 0 || (m === 0 && t.getDate() < d.getDate())) a--;
    return a;
  };
  const applicantAge = ageFromDob(form.dateOfBirth);
  const dobUnderage = form.dateOfBirth && applicantAge !== null && applicantAge < LEGAL_WORKING_AGE;
  // Latest DOB allowed (exactly LEGAL_WORKING_AGE years ago) — guides the date picker.
  const maxDob = (() => {
    const t = new Date();
    t.setFullYear(t.getFullYear() - LEGAL_WORKING_AGE);
    return t.toISOString().slice(0, 10);
  })();

  // Document labels adapt to the selected identity type.
  const DOC_LABELS = {
    MyKad: { front: translate("auth.docMyKadFront"), back: translate("auth.docMyKadBack") },
    MyPR: { front: translate("auth.docMyPRFront"), back: translate("auth.docMyPRBack") },
    Passport: { front: translate("auth.docPassportFront"), back: translate("auth.docPassportBack") },
  }[form.identityType] || { front: translate("auth.docIdFront"), back: translate("auth.docIdBack") };

  // Client-side OCR: read the ID off the uploaded front photo and compare with
  // the typed identity number. Runs entirely in the browser (the image is never
  // sent anywhere for this check) and is advisory only — it never blocks submit.
  const normalizeId = s => (s || "").toUpperCase().replace(/[^0-9A-Z]/g, "");
  const verifyIdOnImage = async file => {
    const entered = normalizeId(form.idNumber);
    if (!file || !file.type?.startsWith("image/") || entered.length < 6) {
      setIdOcr({ status: "idle" });
      return;
    }
    setIdOcr({ status: "checking" });
    try {
      const T = await import(/* @vite-ignore */ "https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.esm.min.js");
      const recognize = T.recognize || T.default?.recognize;
      const { data } = await recognize(file, "eng");
      const ocr = normalizeId(data?.text);
      // For numeric IDs (MyKad/MyPR) compare digit runs; for passports, alnum.
      const enteredDigits = entered.replace(/[^0-9]/g, "");
      const ocrDigits = ocr.replace(/[^0-9]/g, "");
      const matched = form.identityType === "Passport"
        ? ocr.includes(entered)
        : (enteredDigits.length >= 6 && ocrDigits.includes(enteredDigits));
      setIdOcr({ status: matched ? "match" : "mismatch" });
    } catch (e) {
      // OCR engine unavailable / failed — stay silent, never block the user.
      setIdOcr({ status: "idle" });
    }
  };

  const REGISTER_FIELD_LABELS = {
    fullName: translate("auth.fieldFullName"), phone: translate("auth.fieldPhone"), email: translate("auth.fieldEmail"),
    password: translate("auth.fieldPassword"), confirmPassword: translate("auth.fieldConfirmPassword"), idNumber: translate("auth.fieldIdNumber"),
    dateOfBirth: dobUnderage ? translate("auth.fieldDateOfBirthAge").replace("{age}", LEGAL_WORKING_AGE) : translate("auth.fieldDateOfBirth"),
    address: translate("auth.fieldAddress"), kycFront: DOC_LABELS.front,
    kycBack: DOC_LABELS.back, selfie: translate("auth.fieldSelfie"), agreedToTnC: translate("auth.fieldTnC"),
  };
  const registerErrors = {
    fullName: !form.fullName?.trim(),
    phone: !form.phone?.trim(),
    email: !emailOk,
    password: !form.password,
    confirmPassword: !form.confirmPassword || form.password !== form.confirmPassword,
    idNumber: !form.idNumber?.trim(),
    dateOfBirth: !form.dateOfBirth || dobUnderage,
    address: !form.address?.trim(),
    kycFront: !form.kycFront,
    kycBack: !form.kycBack,
    selfie: !form.selfie,
    agreedToTnC: !form.agreedToTnC,
  };
  const hasRegisterErrors = Object.values(registerErrors).some(Boolean);
  const fieldError = k => showErrors && registerErrors[k];
  const missingLabels = Object.keys(registerErrors).filter(k => registerErrors[k]).map(k => REGISTER_FIELD_LABELS[k]);

  const handleRegisterSubmit = e => {
    e.preventDefault();
    if (hasRegisterErrors) {
      setShowErrors(true);
      if (scrollRef.current) scrollRef.current.scrollTo({ top: 0, behavior: "smooth" });
      return;
    }
    onRegister(e);
  };

  if (!open) return null;

  const copy = {
    signin: {
      title: translate("common.signIn"),
      subtitle: translate("auth.signinSubtitle"),
      action: translate("common.signIn"),
    },
    register: {
      title: translate("auth.registerTitle"),
      subtitle: translate("auth.registerSubtitle"),
      action: translate("common.createAccount"),
    },
    reset: {
      title: translate("auth.resetTitle"),
      subtitle: translate("auth.resetSubtitle"),
      action: translate("auth.sendResetEmail"),
    },
  }[view];

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 300, background: "rgba(17,24,39,0.58)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }} onClick={onClose}>
      <div
        style={{ width: "100%", maxWidth: view === "register" ? 640 : 440, maxHeight: "90vh", background: BRAND.surface, borderRadius: 20, boxShadow: `0 24px 70px ${BRAND.shadow}`, overflow: "hidden", display: "flex", flexDirection: "column" }}
        onClick={e => e.stopPropagation()}
      >
        <div style={{ padding: "18px 20px", borderBottom: `1px solid ${BRAND.border}`, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, background: `linear-gradient(135deg, ${BRAND.primaryLight}, ${BRAND.surface})`, flexShrink: 0 }}>
          <div>
            <div style={{ fontSize: 18, fontWeight: 800, color: BRAND.text }}>{copy.title}</div>
            <div style={{ fontSize: 12, color: BRAND.textMuted, marginTop: 4 }}>{copy.subtitle}</div>
          </div>
          <button onClick={onClose} style={{ border: "none", background: "transparent", cursor: "pointer", fontSize: 20, color: BRAND.textMuted, lineHeight: 1 }} aria-label="Close">{Icons.Close({ size: 20 })}</button>
        </div>

        <div ref={scrollRef} style={{ flex: 1, overflowY: "auto", padding: 20, display: "flex", flexDirection: "column" }}>
          {message && (
            <div style={{ position: "sticky", top: -20, zIndex: 10, margin: "-20px -4px 16px -4px", padding: "14px 16px", borderRadius: 12, background: "#EFF6FF", border: `1.5px solid ${BRAND.primary}`, color: BRAND.text, fontSize: 13.5, fontWeight: 600, lineHeight: 1.5, boxShadow: "0 4px 14px rgba(37,99,235,0.15)" }}>
              {message}
            </div>
          )}
          {showErrors && hasRegisterErrors && view === "register" && (
            <div style={{ position: "sticky", top: message ? 52 : -20, zIndex: 9, margin: "0 -4px 16px -4px", padding: "12px 16px", borderRadius: 12, background: "#FEF2F2", border: `1.5px solid ${BRAND.red}`, color: BRAND.red, fontSize: 13, lineHeight: 1.6 }}>
              <strong>{translate("auth.pleaseCompleteFields")}</strong> {missingLabels.join(", ")}
            </div>
          )}
          {view === "signin" && (
            <form onSubmit={onSignIn}>
              <Input label={translate("auth.emailAddress")} type="email" placeholder="name@example.com" value={form.email} onChange={e => onChange("email", e.target.value)} />
              <PasswordInput label={translate("auth.password")} placeholder="Enter your password" value={form.password} onChange={e => onChange("password", e.target.value)} />
              <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", marginTop: -6, marginBottom: 16 }}>
                <button type="button" onClick={() => onViewChange("reset")} style={{ border: "none", background: "transparent", color: BRAND.primary, cursor: "pointer", padding: 0, fontSize: 13, fontWeight: 600 }}>{translate("auth.forgetPassword")}</button>
                <button type="button" onClick={() => onViewChange("register")} style={{ border: "none", background: "transparent", color: BRAND.primary, cursor: "pointer", padding: 0, fontSize: 13, fontWeight: 600 }}>{translate("auth.noAccountYet")}</button>
              </div>
              <Btn type="submit" disabled={loading} style={{ width: "100%", justifyContent: "center" }}>{copy.action}</Btn>
              <SocialAuthButtons onOAuth={onOAuth} label="Sign in" />
            </form>
          )}

          {view === "reset" && (
            <form onSubmit={onResetPassword}>
              <Input label={translate("auth.emailAddress")} type="email" placeholder="name@example.com" value={form.email} onChange={e => onChange("email", e.target.value)} />
              <div style={{ fontSize: 12, color: BRAND.textMuted, marginTop: -6, marginBottom: 16, lineHeight: 1.5 }}>{translate("auth.resetHint")}</div>
              <div style={{ display: "flex", gap: 10, marginBottom: 12 }}>
                <Btn variant="secondary" type="button" onClick={() => onViewChange("signin")} style={{ flex: 1, justifyContent: "center" }}>{translate("common.back")}</Btn>
                <Btn type="submit" disabled={loading} style={{ flex: 1, justifyContent: "center" }}>{copy.action}</Btn>
              </div>
            </form>
          )}

          {view === "register" && (
            <form onSubmit={handleRegisterSubmit} noValidate>
              <div style={{ marginBottom: 16 }}>
                <label style={{ display: "block", fontSize: 13, fontWeight: 600, color: BRAND.text, marginBottom: 8 }}>I want to…</label>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                  {[
                    { value: "worker", title: "Find shift work", hint: "Browse and bid on shifts" },
                    { value: "employer", title: "Hire workers", hint: "Post shifts and manage applicants" },
                  ].map(opt => (
                    <label key={opt.value} style={{
                      display: "block", padding: "10px 12px", borderRadius: 10, cursor: "pointer",
                      border: `1.5px solid ${form.accountRole === opt.value ? BRAND.primary : BRAND.border}`,
                      background: form.accountRole === opt.value ? BRAND.primaryLight : BRAND.surface,
                    }}>
                      <input type="radio" name="accountRole" value={opt.value} checked={form.accountRole === opt.value} onChange={() => onChange("accountRole", opt.value)} style={{ marginRight: 6 }} />
                      <span style={{ fontSize: 13, fontWeight: 700, color: BRAND.text }}>{opt.title}</span>
                      <div style={{ fontSize: 11, color: BRAND.textMuted, marginLeft: 20 }}>{opt.hint}</div>
                    </label>
                  ))}
                </div>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <Input label={translate("auth.fullName")} placeholder="e.g. Nurul Ain Hassan" value={form.fullName} onChange={e => onChange("fullName", e.target.value)} error={fieldError("fullName")} />
                  <SearchableCountrySelect label={translate("auth.country")} value={form.countryOfOrigin} onChange={e => onChange("countryOfOrigin", e.target.value)} />
              </div>
                <div style={{ marginBottom: 16 }}>
                  <label style={{ display: "block", fontSize: 13, fontWeight: 600, color: BRAND.text, marginBottom: 6 }}>{translate("auth.phoneNumber")}</label>
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
                        error={fieldError("phone")}
                      />
                    </div>
                  </div>
                </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <Input label={translate("auth.emailAddressReq")} type="email" placeholder="name@example.com" value={form.email} onChange={e => onChange("email", e.target.value)} error={fieldError("email")} />
                <PasswordInput label={translate("auth.passwordReq")} placeholder={translate("auth.createPassword")} value={form.password} onChange={e => onChange("password", e.target.value)} error={fieldError("password")} />
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <PasswordInput label={translate("auth.confirmPasswordReq")} placeholder={translate("auth.retypePassword")} value={form.confirmPassword} onChange={e => onChange("confirmPassword", e.target.value)} hideToggle={true} error={fieldError("confirmPassword")} />
              </div>
              {form.confirmPassword !== "" && form.password !== form.confirmPassword && (
                <div style={{ color: BRAND.red, fontSize: 13, marginTop: -8, marginBottom: 12 }}>{translate("auth.passwordsNoMatch")}</div>
              )}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <Select
                  label={translate("auth.identityType")}
                  value={form.identityType}
                  onChange={e => {
                    const nextType = e.target.value;
                    onChange("identityType", nextType);
                    onChange("idNumber", "");
                  }}
                  options={[
                    { value: "MyKad", label: translate("auth.icMyKad") },
                    { value: "Passport", label: translate("auth.passport") },
                    { value: "MyPR", label: translate("auth.myPR") },
                  ]}
                />
                <Input
                  label={form.identityType === "MyKad" ? translate("auth.myKadNumber") : form.identityType === "MyPR" ? translate("auth.myPRNumber") : translate("auth.passportNumber")}
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
                  error={fieldError("idNumber")}
                />
              </div>
              <Input
                label={translate("auth.dateOfBirth")}
                type="date"
                value={form.dateOfBirth}
                onChange={e => onChange("dateOfBirth", e.target.value)}
                error={fieldError("dateOfBirth")}
                max={maxDob}
                style={{ marginBottom: dobUnderage ? 4 : 16 }}
              />
              {dobUnderage && (
                <div style={{ fontSize: 12, color: BRAND.red, fontWeight: 600, lineHeight: 1.5, marginBottom: 12 }}>
                  {translate("auth.underageWarning").replace("{age}", LEGAL_WORKING_AGE)}
                </div>
              )}
              <div style={{ fontSize: 12, color: BRAND.textMuted, lineHeight: 1.5, marginTop: dobUnderage ? 0 : -12, marginBottom: 16 }}>
                {translate("auth.kycLevelNote")}
              </div>
              <Input label={translate("auth.address")} placeholder={translate("auth.addressPlaceholder")} value={form.address} onChange={e => onChange("address", e.target.value)} error={fieldError("address")} />
              <div style={{ fontSize: 13, fontWeight: 700, color: BRAND.text, marginBottom: 4 }}>{translate("auth.uploadDocuments")}</div>
              <div style={{ fontSize: 12, color: BRAND.textMuted, marginBottom: 10, lineHeight: 1.5 }}>
                {translate("auth.uploadDocumentsHint").replace("{doc}", form.identityType === "Passport" ? translate("auth.passportDoc") : form.identityType === "MyPR" ? translate("auth.myPRCardDoc") : translate("auth.myKadDoc"))}
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <FileInput label={`${DOC_LABELS.front} *`} accept="image/*,application/pdf" onChange={e => { const f = e.target.files?.[0] || null; onChange("kycFront", f); verifyIdOnImage(f); }} fileName={form.kycFront?.name} helper={translate("auth.uploadFrontHelper")} error={fieldError("kycFront")} />
                <FileInput label={`${DOC_LABELS.back} *`} accept="image/*,application/pdf" onChange={e => onChange("kycBack", e.target.files?.[0] || null)} fileName={form.kycBack?.name} helper={translate("auth.uploadBackHelper")} error={fieldError("kycBack")} />
              </div>
              {idOcr.status === "checking" && (
                <div style={{ fontSize: 12, color: BRAND.textMuted, marginBottom: 12, display: "flex", alignItems: "center", gap: 6 }}>
                  <span style={{ display: "inline-block", width: 12, height: 12, border: `2px solid ${BRAND.border}`, borderTopColor: BRAND.primary, borderRadius: "50%", animation: "cg-spin 0.7s linear infinite" }} />
                  {translate("auth.ocrChecking")}
                </div>
              )}
              {idOcr.status === "match" && (
                <div style={{ fontSize: 12, color: BRAND.green, fontWeight: 600, marginBottom: 12, padding: "8px 12px", background: "#ECFDF5", border: `1px solid ${BRAND.green}`, borderRadius: 8 }}>
                  {translate("auth.ocrMatch")}
                </div>
              )}
              {idOcr.status === "mismatch" && (
                <div style={{ fontSize: 12, color: "#B45309", marginBottom: 12, padding: "10px 12px", background: "#FFFBEB", border: "1px solid #F59E0B", borderRadius: 8, lineHeight: 1.6 }}>
                  <strong>{translate("auth.ocrMismatchTitle")}</strong> {translate("auth.ocrMismatchHint")}
                  <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
                    <li>{translate("auth.ocrMismatchReason1")}</li>
                    <li>{translate("auth.ocrMismatchReason2")}</li>
                    <li>{translate("auth.ocrMismatchReason3")}</li>
                  </ul>
                  <div style={{ marginTop: 6 }}>{translate("auth.ocrMismatchAction")}</div>
                </div>
              )}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <FileInput label={translate("auth.selfie")} accept="image/*" onChange={e => onChange("selfie", e.target.files?.[0] || null)} fileName={form.selfie?.name} helper={translate("auth.selfieHelper")} error={fieldError("selfie")} />
                <FileInput label={translate("auth.certification")} accept="image/*,application/pdf" onChange={e => onChange("supportingDoc", e.target.files?.[0] || null)} fileName={form.supportingDoc?.name} helper={translate("auth.certificationHelper")} />
              </div>
              <div style={{ fontSize: 12, color: BRAND.textMuted, lineHeight: 1.5, marginTop: -4, marginBottom: 16 }}>
                {translate("auth.finalRegisterHint")}
              </div>
              {/* T&C consent — PDPA 2010 (Act 709), Employment Act 1955 (Act 265) */}
              <TnCConsent checked={form.agreedToTnC} onChange={v => onChange("agreedToTnC", v)} error={fieldError("agreedToTnC")} />
              <div style={{ display: "flex", gap: 10 }}>
                <Btn variant="secondary" type="button" onClick={() => onViewChange("signin")} style={{ flex: 1, justifyContent: "center" }}>{translate("common.back")}</Btn>
                <Btn type="submit" disabled={loading} style={{ flex: 1, justifyContent: "center" }}>{copy.action}</Btn>
              </div>
              <SocialAuthButtons onOAuth={onOAuth} label="Sign up" />
              <div style={{ fontSize: 11, color: BRAND.textMuted, lineHeight: 1.5, marginTop: 4, textAlign: "center" }}>
                Signing up with Google, Apple, or Facebook creates your account instantly. You'll be asked to complete identity (KYC) verification afterwards to start working.
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  );
};

// ─── Mock data ───────────────────────────────────────────────────────────────
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

// ─── WORKER PORTAL ───────────────────────────────────────────────────────────
const WorkerPortal = ({ onOpenPortal, isMobile = false, user = null, userRole = null, onRequireAuth = () => {}, onUserUpdated = () => {}, homeSignal = 0 }) => {
  const toast = useToast();
  const { t, language, setLanguage } = useLanguage();
  const [avatarUploading, setAvatarUploading] = useState(false);

  const handleAvatarUpload = async (file) => {
    if (!file || !user) return;
    setAvatarUploading(true);
    try {
      const path = await uploadAvatarFile(user.id, file);
      const { error } = await supabase.auth.updateUser({
        data: { ...user.user_metadata, avatar_url: path },
      });
      if (error) throw error;
      // Mirror to the public profiles table so employers can see the photo.
      await supabase.from("profiles").upsert(
        { id: user.id, avatar_url: path, full_name: user.user_metadata?.full_name || null },
        { onConflict: "id" }
      );
      await onUserUpdated();
      toast(t("toast.avatarUpdated"), "success");
    } catch (err) {
      toast(`${t("toast.avatarUpdateFailed")}${err.message}`, "error");
    }
    setAvatarUploading(false);
  };
  const [profileStats, setProfileStats] = useState({ reliability_score: 0, rating: 0 });
  const [tab, setTab] = useState("discover");
  const [showTnC, setShowTnC] = useState(false);
  const [selectedShift, setSelectedShift] = useState(null);
  const [showBidModal, setShowBidModal] = useState(false);
  const [bidAmount, setBidAmount] = useState("");
  const [bidSuccess, setBidSuccess] = useState(false);
  const [filterCat, setFilterCat] = useState("All");
  const [showQR, setShowQR] = useState(false);
  const [liveApplications, setLiveApplications] = useState(null);
  const [selectedApplication, setSelectedApplication] = useState(null);
  const [cancellingBid, setCancellingBid] = useState(false);
  const [workerBanking, setWorkerBanking] = useState(null);
  const [workerBankForm, setWorkerBankForm] = useState({
    bankName: MALAYSIAN_BANK_OPTIONS[0],
    accountHolderName: "",
    accountNumber: "",
  });
  const [bankingLoading, setBankingLoading] = useState(false);
  const [bankingMessage, setBankingMessage] = useState("");
  const [livePayouts, setLivePayouts] = useState(null);
  const [liveShifts, setLiveShifts] = useState(null);
  const [filterCity, setFilterCity] = useState('');
  const [filterArea, setFilterArea] = useState('');
  const [filterDate, setFilterDate] = useState('');
  const [filterPayMin, setFilterPayMin] = useState('');
  const [filterPayMax, setFilterPayMax] = useState('');
  const [showFilters, setShowFilters] = useState(false);
  const [filterDuration, setFilterDuration] = useState('');
  const [filterHighBooking, setFilterHighBooking] = useState(false);
  const [filterWeekend, setFilterWeekend] = useState(false);
  const [filterTimeStart, setFilterTimeStart] = useState('');
  const [filterTimeEnd, setFilterTimeEnd] = useState('');
  const [chatConversations, setChatConversations] = useState([]);
  const [activeChatShift, setActiveChatShift] = useState(null);
  const [chatMessages, setChatMessages] = useState([]);
  const [chatInput, setChatInput] = useState('');
  const [chatLoading, setChatLoading] = useState(false);
  const [workerContractModal, setWorkerContractModal] = useState(null); // { applicationId, shiftTitle, shiftDate, wageAsk, employerName }

  const navBaseHeight = isMobile ? 60 : 72;
  const navSafeAreaInset = "env(safe-area-inset-bottom, 0px)";
  const navHeight = `calc(${navBaseHeight}px + ${navSafeAreaInset})`;
  const navPadding = `calc(16px + ${navSafeAreaInset})`;

  useEffect(() => {
    if (!user || tab !== 'profile') return;
    let active = true;
    supabase.from('profiles').select('reliability_score, rating')
      .eq('id', user.id).single()
      .then(({ data }) => {
        if (active && data) setProfileStats({
          reliability_score: data.reliability_score ?? 0,
          rating: data.rating ?? 0
        });
      });
    return () => { active = false; };
  }, [user, tab]);

  useEffect(() => {
    if (!user || tab !== 'chat') return;
    let active = true;
    supabase
      .from('applications')
      .select('shift_id, shift:shifts(id, title, start_at, employer_id)')
      .eq('worker_id', user.id)
      .eq('status', 'accepted')
      .then(({ data }) => {
        if (!active) return;
        setChatConversations((data ?? []).map(a => ({
          shiftId: a.shift_id,
          title: a.shift?.title ?? 'Shift',
          date: a.shift?.start_at ? new Date(a.shift.start_at).toLocaleDateString('en-MY') : '',
          otherUserId: a.shift?.employer_id,
          otherUserLabel: 'Employer',
        })));
      });
    return () => { active = false; };
  }, [user, tab]);

  useEffect(() => {
    if (!activeChatShift || !user) return;
    setChatLoading(true);
    let active = true;
    supabase
      .from('messages')
      .select('id, sender_id, content, created_at, read_at')
      .eq('shift_id', activeChatShift.shiftId)
      .order('created_at', { ascending: true })
      .then(({ data }) => {
        if (!active) return;
        setChatMessages(data ?? []);
        setChatLoading(false);
      });
    const channel = supabase
      .channel(`chat-${activeChatShift.shiftId}`)
      .on('postgres_changes', {
        event: 'INSERT',
        schema: 'public',
        table: 'messages',
        filter: `shift_id=eq.${activeChatShift.shiftId}`,
      }, payload => {
        if (active) setChatMessages(prev => [...prev, payload.new]);
      })
      .subscribe();
    return () => {
      active = false;
      supabase.removeChannel(channel);
    };
  }, [activeChatShift, user]);

  const sendMessage = async () => {
    if (!chatInput.trim() || !activeChatShift || !user) return;
    const content = chatInput.trim();
    setChatInput('');
    const { error } = await supabase.from('messages').insert({
      shift_id:     activeChatShift.shiftId,
      sender_id:    user.id,
      recipient_id: activeChatShift.otherUserId,
      content,
    });
    if (error) {
      toast(t('toast.sendFailed') + error.message, 'error');
      setChatInput(content); // restore on failure
    }
  };

  useEffect(() => {
    let active = true;
    const loadApplications = async () => {
      if (!user) return setLiveApplications(null);
      const { data, error } = await supabase
        .from('applications')
        .select('id, shift_id, wage_ask, status, applied_at, worker_signed_at, shift:shifts(id, title, description, category, location, start_at, end_at, wage_min, wage_max, headcount, dress_code, employer_id, transport_allowance, status)')
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
        appliedAt: a.applied_at,
        workerSignedAt: a.worker_signed_at ?? null,
        shiftId: a.shift_id ?? a.shift?.id ?? null,
        employerId: a.shift?.employer_id ?? null,
        shiftStartAt: a.shift?.start_at ?? null,
        shiftEndAt: a.shift?.end_at ?? null,
        shiftLocation: a.shift?.location ?? '',
        shiftCategory: a.shift?.category ?? '',
        shiftWageMin: Number(a.shift?.wage_min ?? 0),
        shiftWageMax: Number(a.shift?.wage_max ?? 0),
        shiftHeadcount: a.shift?.headcount ?? 1,
        shiftDress: a.shift?.dress_code ?? '',
        shiftDescription: a.shift?.description ?? '',
        shiftStipend: Number(a.shift?.transport_allowance ?? 0),
        shiftStatus: a.shift?.status ?? null,
      })));
    };
    loadApplications();
    return () => { active = false; };
  }, [user]);

  // Cancel (withdraw) a pending bid. Matches the RLS policy: worker may
  // update their own application from 'pending' to 'withdrawn' only.
  const cancelBid = async (applicationId) => {
    setCancellingBid(true);
    const { error } = await supabase.from('applications').update({ status: 'withdrawn' }).eq('id', applicationId);
    setCancellingBid(false);
    if (error) { toast('Failed to cancel bid: ' + error.message, 'error'); return; }
    toast('Bid cancelled.', 'success');
    setLiveApplications(prev => (prev ?? []).filter(a => a.id !== applicationId));
    setSelectedApplication(null);
  };

  useEffect(() => {
    // Open shifts are publicly browsable (anon RLS policy) so visitors can
    // see listings before signing up. Runs for both anon and signed-in users.
    let active = true;
    supabase
      .from('shifts')
      .select('id, title, description, category, location, dress_code, start_at, end_at, wage_min, wage_max, headcount, filled_count, status, transport_allowance')
      .eq('status', 'open')
      .order('start_at', { ascending: true })
      .then(({ data }) => {
        if (!active) return;
        setLiveShifts((data ?? []).map(s => ({
          id: s.id,
          title: s.title,
          description: s.description || '',
          category: s.category,
          employer: 'Employer',
          location: s.location,
          date: s.start_at ? s.start_at.slice(0, 10) : '',
          time: s.start_at && s.end_at
            ? `${new Date(s.start_at).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}–${new Date(s.end_at).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}`
            : 'TBA',
          hours: s.start_at && s.end_at
            ? Math.round((new Date(s.end_at) - new Date(s.start_at)) / 3600000)
            : 0,
          wageMin: Number(s.wage_min),
          wageMax: Number(s.wage_max),
          headcount: s.headcount,
          filled: s.filled_count,
          status: s.status,
          addressVisibility: s.address_visibility || 'public',
          totalApplicants: 0,
          dress: s.dress_code || '',
          stipend: Number(s.transport_allowance) || 0,
          travelTime: '',
          distance: 0,
          startTime: s.start_at ? (() => { const d = new Date(s.start_at); return String(d.getHours()).padStart(2,'0') + ':' + String(d.getMinutes()).padStart(2,'0'); })() : '',
          endTime: s.end_at ? (() => { const d = new Date(s.end_at); return String(d.getHours()).padStart(2,'0') + ':' + String(d.getMinutes()).padStart(2,'0'); })() : '',
          date: s.start_at ? new Date(s.start_at).toISOString().slice(0, 10) : '',
        })));
      })
      .catch(() => { if (active) setLiveShifts([]); });
    return () => { active = false; };
  }, [user]);

  useEffect(() => {
    let active = true;
    const loadWorkerPayoutData = async () => {
      if (!user) {
        setWorkerBanking(null);
        setLivePayouts(null);
        return;
      }

      const [{ data: bankData, error: bankError }, { data: payoutData, error: payoutError }] = await Promise.all([
        supabase
          .from("banking_details")
          .select("id, bank_name, account_holder_name, account_number_last4, verification_status, verification_provider, verified_at")
          .eq("user_id", user.id)
          .eq("role", "worker")
          .maybeSingle(),
        supabase
          .from("payout_item")
          .select("id, amount, scheduled_date, status, source_refs, created_at")
          .eq("worker_id", user.id)
          .order("created_at", { ascending: false })
          .limit(10),
      ]);

      if (!active) return;

      if (!bankError) {
        setWorkerBanking(bankData ?? null);
        if (bankData) {
          setWorkerBankForm({
            bankName: bankData.bank_name || MALAYSIAN_BANK_OPTIONS[0],
            accountHolderName: bankData.account_holder_name || "",
            accountNumber: "",
          });
        }
      }

      if (!payoutError) {
        setLivePayouts(payoutData ?? []);
      }
    };

    loadWorkerPayoutData();
    return () => {
      active = false;
    };
  }, [user]);

  const saveWorkerBankingDetails = async () => {
    if (!user) {
      setBankingMessage("Sign in to save banking details.");
      return;
    }
    if (!workerBankForm.accountHolderName.trim() || !workerBankForm.accountNumber.trim()) {
      setBankingMessage("Account holder name and account number are required.");
      return;
    }
    const workerAcctValidation = validateMalaysianBankAccount(workerBankForm.bankName, workerBankForm.accountNumber);
    if (!workerAcctValidation.valid) {
      toast(workerAcctValidation.message, "error");
      return;
    }

    setBankingLoading(true);
    setBankingMessage("");
    const accountDigits = workerBankForm.accountNumber.replace(/\D/g, "");
    const last4 = accountDigits.slice(-4);
    const payload = {
      user_id: user.id,
      role: "worker",
      bank_name: workerBankForm.bankName,
      bank_code: workerBankForm.bankName.toUpperCase().replace(/\s+/g, "_"),
      account_holder_name: workerBankForm.accountHolderName.trim(),
      account_number_last4: last4,
      // Full account number must be encrypted server-side before go-live.
      // Storing masked placeholder here until a backend encryption flow is wired up.
      account_number_encrypted: `MASKED-${last4}`,
      verification_status: workerBanking?.verification_status || "pending",
    };

    const { data, error } = await supabase
      .from("banking_details")
      .upsert(payload, { onConflict: "user_id,role" })
      .select("id, bank_name, account_holder_name, account_number_last4, verification_status, verification_provider, verified_at")
      .single();

    setBankingLoading(false);
    if (error) {
      setBankingMessage(`Unable to save banking details: ${error.message}`);
      return;
    }
    setWorkerBanking(data);
    setBankingMessage("Banking details saved. Please verify with SecureSign.");
  };

  const verifyWorkerBankingDetails = async () => {
    if (!workerBanking?.id) {
      setBankingMessage("Save banking details before starting verification.");
      return;
    }

    setBankingLoading(true);
    setBankingMessage("");
    const { data, error } = await supabase
      .from("banking_details")
      .update({
        verification_status: "verified",
        verification_provider: "secure_sign_sim",
        verification_reference: `SEC-${Date.now()}`,
        verified_at: new Date().toISOString(),
      })
      .eq("id", workerBanking.id)
      .select("id, bank_name, account_holder_name, account_number_last4, verification_status, verification_provider, verified_at")
      .single();

    setBankingLoading(false);
    if (error) {
      setBankingMessage(`Verification failed: ${error.message}`);
      return;
    }
    setWorkerBanking(data);
    setBankingMessage("SecureSign verification completed.");
  };

  const cats = ["All", "F&B", "Retail", "Event", "Logistics"];
  const shiftsSource = liveShifts ?? [];
  // Shifts the worker has an active (still-pending-decision) bid on should not
  // reappear in Discover — they can only place one bid per shift, and the
  // shift already lives in My Bids.
  const appliedShiftIds = useMemo(
    () => new Set((liveApplications ?? []).filter(a => ['pending', 'shortlisted', 'accepted'].includes(a.status)).map(a => a.shiftId)),
    [liveApplications]
  );
  const filtered = useMemo(() => {
    let s = shiftsSource.filter(x => !appliedShiftIds.has(x.id));
    if (filterCat !== 'All') s = s.filter(x => x.category === filterCat);
    if (filterCity) s = s.filter(x => resolveCity(x.location) === filterCity);
    if (filterArea) s = s.filter(x => x.location.toLowerCase().includes(filterArea.toLowerCase()));
    if (filterDate) s = s.filter(x => x.date === filterDate);
    if (filterDuration) s = s.filter(x => x.hours <= Number(filterDuration));
    if (filterPayMin) s = s.filter(x => x.wageMin >= Number(filterPayMin));
    if (filterPayMax) s = s.filter(x => x.wageMax <= Number(filterPayMax));
    if (filterHighBooking) s = s.filter(x => x.headcount > 0 && (x.headcount - (x.filled || 0)) / x.headcount > 0.5);
    if (filterWeekend) s = s.filter(x => x.date && [0, 6].includes(new Date(x.date + 'T00:00:00').getDay()));
    if (filterTimeStart) s = s.filter(x => x.startTime && x.startTime >= filterTimeStart);
    if (filterTimeEnd) s = s.filter(x => x.endTime && x.endTime <= filterTimeEnd);
    return s;
  }, [shiftsSource, appliedShiftIds, filterCat, filterCity, filterArea, filterDate, filterDuration, filterPayMin, filterPayMax, filterHighBooking, filterWeekend, filterTimeStart, filterTimeEnd]);
  const payoutsLoading = Boolean(user) && livePayouts === null;
  const payoutRows = useMemo(
    () => (livePayouts || []).map((p) => ({
      id: p.id,
      shift: p.source_refs?.shift_id ? `Shift #${p.source_refs.shift_id}` : "Completed shift",
      amount: Number(p.amount || 0),
      date: p.scheduled_date ? new Date(p.scheduled_date).toLocaleDateString("en-MY") : "TBA",
      status: p.status,
      travel: 0,
    })),
    [livePayouts]
  );

  const totalEarned = useMemo(
    () => payoutRows.reduce((sum, row) => sum + Number(row.amount || 0), 0),
    [payoutRows]
  );
  const payoutEligibility = workerBanking?.verification_status === "verified";
  const profileName = user
    ? (user.user_metadata?.full_name || user.user_metadata?.name || user.email?.split("@")[0] || "Your account")
    : "";

  const navItems = [
    { id: "discover", label: t("nav.discover"), icon: <Icons.Search size={20} /> },
    { id: "applications", label: t("nav.myBids"), icon: <Icons.List size={20} /> },
    { id: "chat", label: t("nav.chat"), icon: <Icons.Chat size={20} /> },
    { id: "earnings", label: t("nav.earnings"), icon: <Icons.Money size={20} /> },
    { id: "profile", label: t("nav.profile"), icon: <Icons.User size={20} /> },
    { id: "settings", label: t("nav.settings"), icon: <Icons.Settings size={20} /> },
  ];

  const handleWorkerNavClick = (nextTab) => {
    setShowQR(false);
    setShowBidModal(false);
    setSelectedShift(null);
    setTab(nextTab);
  };

  // Logo click in the header bumps homeSignal → return to Discover.
  const isFirstHome = useRef(true);
  useEffect(() => {
    if (isFirstHome.current) { isFirstHome.current = false; return; }
    handleWorkerNavClick("discover");
  }, [homeSignal]);

  const navBarStyle = isMobile
    ? {
        position: "sticky",
        bottom: 0,
        width: "100%",
        zIndex: 20,
        boxShadow: `0 -6px 20px ${BRAND.shadow}`,
        borderTop: `1px solid ${BRAND.border}`,
        background: BRAND.surface,
        display: "flex",
        flexShrink: 0,
        height: navHeight,
        paddingBottom: navSafeAreaInset,
        marginTop: "auto",
      }
    : {
        // Desktop: top navigation row. order:-1 floats it above the
        // content without changing DOM order across the worker screens.
        order: -1,
        position: "sticky",
        top: 0,
        width: "100%",
        zIndex: 20,
        boxShadow: `0 2px 12px ${BRAND.shadow}`,
        borderBottom: `1px solid ${BRAND.border}`,
        background: BRAND.surface,
        display: "flex",
        justifyContent: "center",
        gap: 8,
        flexShrink: 0,
        height: 56,
      };

  // Modal content - rendered on top of main content
  if (showQR) return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", width: "100%", minHeight: 0 }}>
      <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", paddingTop: 32, paddingLeft: 32, paddingRight: 32, paddingBottom: navPadding, background: BRAND.surface, overflow: "auto", minHeight: 0 }}>
        <div style={{ fontSize: 24, fontWeight: 800, color: BRAND.text, marginBottom: 8 }}>Check-in QR Scanner</div>
        <div style={{ color: BRAND.textMuted, fontSize: 14, marginBottom: 32, textAlign: "center" }}>Point your camera at the QR code at the venue entrance</div>
        <div style={{ width: 220, height: 220, background: BRAND.grayLight, borderRadius: 20, display: "flex", alignItems: "center", justifyContent: "center", border: `3px dashed ${BRAND.border}`, marginBottom: 24 }}>
          <div style={{ textAlign: "center" }}>
            <div style={{ fontSize: 48 }}>{Icons.Camera({ size: 48 })}</div>
            <div style={{ fontSize: 12, color: BRAND.textMuted, marginTop: 8 }}>Camera viewfinder</div>
          </div>
        </div>
        <div style={{ background: BRAND.greenLight, color: "#065F46", borderRadius: 12, padding: "12px 20px", fontSize: 14, fontWeight: 600, marginBottom: 16 }}>✓ GPS: KLCC (1.5km — within range)</div>
        <Btn onClick={() => { setShowQR(false); toast(t("toast.checkinSimulated"), "success"); }}>Simulate Successful Check-in</Btn>
        <Btn variant="secondary" onClick={() => setShowQR(false)} style={{ marginTop: 8 }}>Back</Btn>
      </div>
      <div style={navBarStyle}>
        {navItems.map(n => (
          <button key={n.id} onClick={() => handleWorkerNavClick(n.id)} style={{
            flex: isMobile ? 1 : "0 0 auto", padding: isMobile ? "6px 0" : "8px 18px", border: "none", background: "none", cursor: "pointer",
            display: "flex", flexDirection: isMobile ? "column" : "row", alignItems: "center", gap: isMobile ? 2 : 8,
            borderRadius: isMobile ? 0 : 8,
            color: tab === n.id ? BRAND.primary : BRAND.textMuted,
            fontFamily: "inherit",
          }}>
            <span style={{ fontSize: isMobile ? 16 : 18, lineHeight: 1 }}>{n.icon}</span>
            <span style={{ fontSize: isMobile ? 9 : 14, fontWeight: tab === n.id ? 700 : 500, whiteSpace: "nowrap" }}>{n.label}</span>
          </button>
        ))}
      </div>
    </div>
  );

  // Shift detail view with bottom nav
  if (selectedShift) return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", width: "100%", minHeight: 0 }}>
      {showBidModal && (
        <div style={{ position: "fixed", inset: 0, background: BRAND.overlay, display: "flex", alignItems: "flex-end", zIndex: 100, borderRadius: 20 }}>
          <div style={{ background: BRAND.surface, borderRadius: "20px 20px 0 0", padding: 24, width: "100%" }}>
            <div style={{ fontWeight: 800, fontSize: 18, color: BRAND.text, marginBottom: 4 }}>{t("shiftDetail.placeBidTitle")}</div>
            <div style={{ fontSize: 13, color: BRAND.textMuted, marginBottom: 20 }}>
              {t("shiftDetail.employerRange")}{selectedShift.wageMin}–RM{selectedShift.wageMax}/h{t("shiftDetail.maxBid")}{(selectedShift.wageMax * 1.5).toFixed(0)}/h
            </div>
            <div style={{ marginBottom: 16 }}>
              <label style={{ display: "block", fontSize: 13, fontWeight: 600, color: BRAND.text, marginBottom: 6 }}>{t("shiftDetail.wageAskLabel")}</label>
              <WageRatePicker
                min={selectedShift.wageMin}
                max={selectedShift.wageMax * 1.5}
                value={bidAmount || selectedShift.wageMin}
                onChange={v => setBidAmount(String(v))}
              />
              <div style={{ fontSize: 11, color: BRAND.textMuted, textAlign: "center", marginTop: 4 }}>Scroll or tap to choose your rate</div>
            </div>
            {bidAmount && (
              <div style={{ background: BRAND.grayLight, borderRadius: 12, padding: "12px 16px", marginBottom: 16 }}>
                <div style={{ fontSize: 13, color: BRAND.textMuted }}>{t("shiftDetail.estimatedTotalPay")}</div>
                <div style={{ fontSize: 22, fontWeight: 800, color: BRAND.green }}>RM{(parseFloat(bidAmount || 0) * selectedShift.hours).toFixed(0)}</div>
                {selectedShift.stipend > 0 && (
                  <div style={{ fontSize: 12, color: BRAND.textMuted }}>+ RM{selectedShift.stipend}{t("shiftDetail.transportAllowanceSuffix")}</div>
                )}
              </div>
            )}
            <div style={{ display: "flex", gap: 10 }}>
              <Btn variant="secondary" onClick={() => setShowBidModal(false)} style={{ flex: 1 }}>{t("common.cancel")}</Btn>
              <Btn onClick={() => {
                (async () => {
                  if (!bidAmount) return;
                  if (parseFloat(bidAmount) > selectedShift.wageMax * 1.5) { toast(`${t("toast.maxBidPrefix")}${(selectedShift.wageMax * 1.5).toFixed(0)}/h`, "error"); return; }
                  if (!user) { setShowBidModal(false); onRequireAuth("signin"); return; }
                  // Guard: mock shifts use numeric ids — require a real UUID id to insert
                  if (typeof selectedShift.id !== 'string' || !selectedShift.id.includes('-')) {
                    toast(t("toast.sampleShiftBidInfo"), "info");
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
                    toast(t("toast.applicationFailed") + error.message, "error");
                    return;
                  }

                  // Update local UI state and liveApplications cache if present
                  setShowBidModal(false);
                  setBidSuccess(true);
                  setLiveApplications(prev => prev ? [{ id: data[0].id, shiftId: selectedShift.id, shiftTitle: selectedShift.title, employer: selectedShift.employer, date: selectedShift.date, wageBid: Number(bidAmount), status: data[0].status || 'pending', appliedAt: data[0].applied_at }, ...prev] : null);
                  setTimeout(() => { setBidSuccess(false); setSelectedShift(null); setTab('applications'); }, 2000);
                })();
              }} style={{ flex: 1 }}>{t("common.submitBid")}</Btn>
            </div>
          </div>
        </div>
      )}
      {bidSuccess && (
        <div style={{ position: "fixed", inset: 0, background: BRAND.overlay, display: "flex", alignItems: "center", justifyContent: "center", zIndex: 200, borderRadius: 20 }}>
          <div style={{ background: BRAND.surface, borderRadius: 20, padding: isMobile ? 24 : 32, textAlign: "center" }}>
            <div style={{ fontSize: isMobile ? 40 : 48, marginBottom: 12 }}>🎉</div>
            <div style={{ fontWeight: 800, fontSize: isMobile ? 18 : 20, color: BRAND.text }}>{t("shiftDetail.bidSubmitted")}</div>
            <div style={{ color: BRAND.textMuted, fontSize: isMobile ? 12 : 14, marginTop: 8 }}>RM{bidAmount}/h · {t("shiftDetail.bidSubmittedHint")}</div>
          </div>
        </div>
      )}
      <div style={{ flex: 1, overflowY: "auto", paddingBottom: navPadding, display: "flex", flexDirection: "column", minHeight: 0 }}>
        <div style={{ background: `linear-gradient(135deg, ${BRAND.primary}, ${BRAND.primaryDark})`, padding: isMobile ? "32px 16px 16px" : "48px 24px 24px", borderRadius: isMobile ? 0 : "20px 20px 0 0", flexShrink: 0 }}>
          <button onClick={() => setSelectedShift(null)} style={{ background: "rgba(255,255,255,0.2)", border: "none", color: "#fff", borderRadius: 8, padding: "6px 12px", cursor: "pointer", fontSize: 13, marginBottom: 12, fontFamily: "inherit" }} aria-label="Back">{Icons.ArrowLeft({ size: 14 })} <span style={{ marginLeft: 8 }}>{t("common.back")}</span></button>
          <div style={{ display: "flex", gap: 6, marginBottom: 12, flexWrap: "wrap" }}>
            <Badge color="amber">{selectedShift.category}</Badge>
            <Badge color="green">{t("shiftDetail.positions")} {selectedShift.headcount}</Badge>
            <Badge color="blue">{t("shiftDetail.applied")} {selectedShift.totalApplicants}</Badge>
          </div>
          <div style={{ fontSize: isMobile ? 18 : 22, fontWeight: 800, color: "#fff", lineHeight: 1.2, marginBottom: 8 }}>{selectedShift.title}</div>
          <div style={{ fontSize: isMobile ? 12 : 14, color: "rgba(255,255,255,0.85)" }}>{selectedShift.employer}</div>
        </div>
        <div style={{ padding: isMobile ? 14 : 20 }}>
          <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr 1fr" : "1fr 1fr", gap: isMobile ? 8 : 10, marginBottom: 16 }}>
            <Stat label={t("shiftDetail.wageRange")} value={`RM${selectedShift.wageMin}–${selectedShift.wageMax}`} sub={t("shiftDetail.perHour")} color={BRAND.text} />
            <Stat label={t("shiftDetail.shiftDuration")} value={`${selectedShift.hours}h`} sub={`${selectedShift.date}`} color={BRAND.text} />
            <Stat label={t("shiftDetail.estimatedGross")} value={`RM${selectedShift.wageMax * selectedShift.hours}`} sub={t("shiftDetail.atMaxRate")} color={BRAND.green} />
            <Stat label={t("shiftDetail.transportAllowance")} value={selectedShift.stipend > 0 ? `RM${selectedShift.stipend}` : "Not provided"} color={selectedShift.stipend > 0 ? BRAND.blue : BRAND.textMuted} />
          </div>
          {selectedShift.description && (
            <Card style={{ marginBottom: 16 }}>
              <div style={{ fontSize: isMobile ? 12 : 13, fontWeight: 700, color: BRAND.text, marginBottom: 8 }}>{t("shiftDetail.aboutRole")}</div>
              <div style={{ fontSize: 13, color: BRAND.text, lineHeight: 1.6, whiteSpace: "pre-wrap" }}>{selectedShift.description}</div>
            </Card>
          )}
          {(() => {
            // Exact address is shown when the employer made it public, or when
            // this worker has been accepted for the shift. Otherwise only the
            // coarse city/region is shown, with a note explaining why.
            const acceptedForShift = selectedShift.myStatus === "accepted";
            const canSeeExact = selectedShift.addressVisibility !== "accepted_only" || acceptedForShift;
            const detailLocation = canSeeExact ? selectedShift.location : overviewLocation(selectedShift.location);
            const locationNote = canSeeExact ? null : t("shiftDetail.locationNote");
            return (
          <Card style={{ marginBottom: 16 }}>
            <div style={{ fontSize: isMobile ? 12 : 13, fontWeight: 700, color: BRAND.text, marginBottom: 12 }}>{t("shiftDetail.title")}</div>
            {[
              [t("shiftDetail.location"), detailLocation, locationNote],
              [t("shiftDetail.date"), selectedShift.date],
              [t("shiftDetail.time"), selectedShift.time],
              [t("shiftDetail.dressCode"), selectedShift.dress],
              [t("shiftDetail.headcount"), `${selectedShift.headcount} ${t("shiftDetail.workersNeeded")}`],
              [t("shiftDetail.employerScore"), `${selectedShift.reliabilityScore}/100`],
            ].map(([k, v, note]) => (
              <div key={k} style={{ display: "flex", gap: 8, marginBottom: 8 }}>
                <span style={{ fontSize: 13, color: BRAND.textMuted, width: 130, flexShrink: 0 }}>{k}</span>
                <span style={{ fontSize: 13, color: BRAND.text, fontWeight: 500 }}>
                  {v}
                  {note && <span style={{ display: "block", fontSize: 11, color: BRAND.textMuted, fontWeight: 400, marginTop: 2 }}>🔒 {note}</span>}
                </span>
              </div>
            ))}
          </Card>
            );
          })()}
          <Card style={{ marginBottom: 20, background: BRAND.grayLight, border: "none" }}>
            <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 8, color: BRAND.text }}>{t("shiftDetail.employerReliability")}</div>
            <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 8 }}>
              <div style={{ flex: 1 }}><Progress value={selectedShift.reliabilityScore} color={selectedShift.reliabilityScore > 90 ? BRAND.green : selectedShift.reliabilityScore > 75 ? BRAND.accent : BRAND.red} /></div>
              <span style={{ fontWeight: 700, fontSize: 14, color: BRAND.text }}>{selectedShift.reliabilityScore}/100</span>
            </div>
            <div style={{ display: "flex", gap: 16 }}>
              <StarRating value={selectedShift.rating} />
              <span style={{ fontSize: 12, color: BRAND.textMuted }}>{selectedShift.totalApplicants} {t("shiftDetail.applicants")}</span>
            </div>
          </Card>
          <Btn onClick={() => { if (user) { setBidAmount(String(selectedShift.wageMin)); setShowBidModal(true); } else { onRequireAuth("signin"); } }} style={{ width: "100%", justifyContent: "center", fontSize: isMobile ? 14 : 16, padding: isMobile ? "12px 0" : "14px 0", marginBottom: 20 }}>
            {user ? t("common.placeBid") : t("common.signInToBid")}
          </Btn>
        </div>
      </div>
      <div style={navBarStyle}>
        {navItems.map(n => (
          <button key={n.id} onClick={() => handleWorkerNavClick(n.id)} style={{
            flex: isMobile ? 1 : "0 0 auto", padding: isMobile ? "6px 0" : "8px 18px", border: "none", background: "none", cursor: "pointer",
            display: "flex", flexDirection: isMobile ? "column" : "row", alignItems: "center", gap: isMobile ? 2 : 8,
            borderRadius: isMobile ? 0 : 8,
            color: tab === n.id ? BRAND.primary : BRAND.textMuted,
            fontFamily: "inherit",
          }}>
            <span style={{ fontSize: isMobile ? 16 : 18, lineHeight: 1 }}>{n.icon}</span>
            <span style={{ fontSize: isMobile ? 9 : 14, fontWeight: tab === n.id ? 700 : 500, whiteSpace: "nowrap" }}>{n.label}</span>
          </button>
        ))}
      </div>
    </div>
  );

  return (
    <>
    <div style={{ display: "flex", flexDirection: "column", height: "100%", width: "100%", minHeight: 0 }}>
      {/* Content */}
      <div style={{ flex: 1, overflowY: "auto", paddingTop: tab === "discover" ? 0 : isMobile ? 12 : 20, paddingLeft: tab === "discover" ? 0 : isMobile ? 12 : 20, paddingRight: tab === "discover" ? 0 : isMobile ? 12 : 20, paddingBottom: navPadding, width: "100%", maxWidth: isMobile ? "100%" : 1160, margin: isMobile ? 0 : "0 auto", minHeight: 0 }}>
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
            <div style={{ padding: isMobile ? "0 12px 8px" : "0 20px 8px" }}>
              {(() => {
                const activeFilterCount = [filterCity, filterArea, filterDate, filterPayMin, filterPayMax, filterDuration, filterTimeStart, filterTimeEnd].filter(Boolean).length
                  + (filterCat !== 'All' ? 1 : 0)
                  + (filterHighBooking ? 1 : 0)
                  + (filterWeekend ? 1 : 0);
                return (
                  <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:8}}>
                    <button
                      onClick={() => setShowFilters(f => !f)}
                      style={{fontSize:12,padding:'4px 10px',borderRadius:6,border:'1px solid #e2e8f0',background:'#f8fafc',cursor:'pointer',color:'#64748b'}}
                    >
                      {showFilters ? 'Hide Filters ▲' : `Filters${activeFilterCount > 0 ? ` (${activeFilterCount})` : ''} ▼`}
                    </button>
                  </div>
                );
              })()}
              {showFilters && (
                <div style={{marginBottom:12, padding:12, background:'#f8fafc', borderRadius:8, border:'1px solid #e2e8f0'}}>
                  {/* Row 1: Location, Date, Duration */}
                  <div style={{display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:8, marginBottom:8}}>
                    <div>
                      <div style={{fontSize:11, color:'#64748b', marginBottom:3}}>City</div>
                      <select value={filterCity} onChange={e=>{ setFilterCity(e.target.value); setFilterArea(''); }}
                        style={{width:'100%', padding:'6px 8px', borderRadius:6, border:'1px solid #e2e8f0', fontSize:13, boxSizing:'border-box', background:'#fff', marginBottom:4}}>
                        <option value="">Any city</option>
                        {Object.keys(CITY_REGIONS).map(city => (
                          <option key={city} value={city}>{city}</option>
                        ))}
                      </select>
                      {filterCity && (
                        <input placeholder="Area e.g. Bukit Bintang" value={filterArea} onChange={e=>setFilterArea(e.target.value)}
                          style={{width:'100%', padding:'6px 8px', borderRadius:6, border:'1px solid #e2e8f0', fontSize:12, boxSizing:'border-box', color:'#64748b'}} />
                      )}
                    </div>
                    <div>
                      <div style={{fontSize:11, color:'#64748b', marginBottom:3}}>Date</div>
                      <input type="date" value={filterDate} onChange={e=>setFilterDate(e.target.value)}
                        style={{width:'100%', padding:'6px 8px', borderRadius:6, border:'1px solid #e2e8f0', fontSize:13, boxSizing:'border-box'}} />
                    </div>
                    <div>
                      <div style={{fontSize:11, color:'#64748b', marginBottom:3}}>Max Duration (hrs)</div>
                      <input type="number" min="0" placeholder="e.g. 8" value={filterDuration} onChange={e=>setFilterDuration(e.target.value)}
                        style={{width:'100%', padding:'6px 8px', borderRadius:6, border:'1px solid #e2e8f0', fontSize:13, boxSizing:'border-box'}} />
                    </div>
                  </div>
                  {/* Row 2: Job type, Min pay, Max pay */}
                  <div style={{display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:8, marginBottom:8}}>
                    <div>
                      <div style={{fontSize:11, color:'#64748b', marginBottom:3}}>Job Type</div>
                      <select value={filterCat} onChange={e=>setFilterCat(e.target.value)}
                        style={{width:'100%', padding:'6px 8px', borderRadius:6, border:'1px solid #e2e8f0', fontSize:13, boxSizing:'border-box', background:'#fff'}}>
                        <option value="All">All types</option>
                        <option value="F&B">F&B</option>
                        <option value="Retail">Retail</option>
                        <option value="Event">Event</option>
                        <option value="Logistics">Logistics</option>
                        <option value="Other">Other</option>
                      </select>
                    </div>
                    <div>
                      <div style={{fontSize:11, color:'#64748b', marginBottom:3}}>Min Pay (RM/hr)</div>
                      <input type="number" min="0" placeholder="e.g. 10" value={filterPayMin} onChange={e=>setFilterPayMin(e.target.value)}
                        style={{width:'100%', padding:'6px 8px', borderRadius:6, border:'1px solid #e2e8f0', fontSize:13, boxSizing:'border-box'}} />
                    </div>
                    <div>
                      <div style={{fontSize:11, color:'#64748b', marginBottom:3}}>Max Pay (RM/hr)</div>
                      <input type="number" min="0" placeholder="e.g. 25" value={filterPayMax} onChange={e=>setFilterPayMax(e.target.value)}
                        style={{width:'100%', padding:'6px 8px', borderRadius:6, border:'1px solid #e2e8f0', fontSize:13, boxSizing:'border-box'}} />
                    </div>
                  </div>
                  {/* Row 3: Start time, End time */}
                  <div style={{display:'grid', gridTemplateColumns:'1fr 1fr', gap:8, marginBottom:8}}>
                    <div>
                      <div style={{fontSize:11, color:'#64748b', marginBottom:3}}>Starts after</div>
                      <input type="time" value={filterTimeStart} onChange={e=>setFilterTimeStart(e.target.value)}
                        style={{width:'100%', padding:'6px 8px', borderRadius:6, border:'1px solid #e2e8f0', fontSize:13, boxSizing:'border-box'}} />
                    </div>
                    <div>
                      <div style={{fontSize:11, color:'#64748b', marginBottom:3}}>Ends by</div>
                      <input type="time" value={filterTimeEnd} onChange={e=>setFilterTimeEnd(e.target.value)}
                        style={{width:'100%', padding:'6px 8px', borderRadius:6, border:'1px solid #e2e8f0', fontSize:13, boxSizing:'border-box'}} />
                    </div>
                  </div>
                  {/* Row 4: Toggles */}
                  <div style={{display:'flex', gap:16, flexWrap:'wrap'}}>
                    <label style={{display:'flex', alignItems:'center', gap:6, cursor:'pointer', fontSize:13, color:'#374151'}}>
                      <input type="checkbox" checked={filterHighBooking} onChange={e=>setFilterHighBooking(e.target.checked)}
                        style={{width:15, height:15, accentColor:'#2563EB'}} />
                      🔥 High booking chance
                    </label>
                    <label style={{display:'flex', alignItems:'center', gap:6, cursor:'pointer', fontSize:13, color:'#374151'}}>
                      <input type="checkbox" checked={filterWeekend} onChange={e=>setFilterWeekend(e.target.checked)}
                        style={{width:15, height:15, accentColor:'#2563EB'}} />
                      📅 Weekends only
                    </label>
                  </div>
                  {/* Clear all button */}
                  <div style={{display:'flex', justifyContent:'flex-end', marginTop:8}}>
                    {(filterCity||filterArea||filterDate||filterPayMin||filterPayMax||filterDuration||filterCat!=='All'||filterHighBooking||filterWeekend||filterTimeStart||filterTimeEnd) && (
                      <button onClick={() => {
                        setFilterCity(''); setFilterArea(''); setFilterDate(''); setFilterPayMin(''); setFilterPayMax('');
                        setFilterDuration(''); setFilterCat('All');
                        setFilterHighBooking(false); setFilterWeekend(false);
                        setFilterTimeStart(''); setFilterTimeEnd('');
                      }} style={{fontSize:12, padding:'5px 14px', borderRadius:6, border:'1px solid #fca5a5', background:'#fef2f2', cursor:'pointer', color:'#ef4444'}}>
                        Clear all
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>
            <div style={{ padding: isMobile ? "8px 12px 12px" : "8px 20px 20px", display: "flex", flexDirection: "column", gap: 12 }}>
              {filtered.length === 0 && (
                <EmptyState
                  icon="🔍"
                  title={liveShifts === null ? "Loading shifts…" : "No shifts match right now"}
                  hint={liveShifts === null ? "Hang tight while we fetch open shifts." : "Try widening your filters, or check back soon — new shifts are posted regularly."}
                />
              )}
              {filtered.map(s => (
                <Card key={s.id} onClick={() => setSelectedShift(s)} hover style={{ padding: 0, overflow: "hidden" }}>
                  <div style={{ padding: "12px 12px 0" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 6, gap: 8 }}>
                      <div style={{ flex: 1 }}>
                        <div style={{ display: "flex", gap: 4, marginBottom: 6, flexWrap: "wrap" }}>
                          <Badge color="amber" size="xs">{s.category}</Badge>
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
                      // Listing cards only ever show the city/region, never the exact place.
                      [overviewLocation(s.location), "📍"],
                      [`${s.hours}h`, "⏱️"],
                      [`${s.headcount} pos · ${s.totalApplicants} applied`, "👥"],
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

        {tab === "applications" && !user && (
          <AuthGate
            onRequireAuth={onRequireAuth}
            icon="📄"
            title="Sign in to view your bids"
            hint="Track the shifts you've applied to and their status once you're signed in."
          />
        )}

        {tab === "applications" && user && !selectedApplication && (
          <div>
            <div style={{ fontSize: isMobile ? 18 : 20, fontWeight: 800, color: BRAND.text, marginBottom: 4 }}>{t("nav.myBids")}</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {(liveApplications ?? []).length === 0 && (
                <EmptyState
                  icon="📄"
                  title={liveApplications === null ? "Loading your bids…" : "No bids yet"}
                  hint={liveApplications === null ? "Hang tight while we fetch your bids." : "Head to Discover and place a bid on a shift to see it here."}
                />
              )}
              {(liveApplications ?? []).map(a => (
                <Card key={a.id} onClick={() => setSelectedApplication(a)} hover>
                  {a.status === "pending" && a.shiftStartAt && a.shiftStatus !== "cancelled" && (
                    <div style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "2px 8px", borderRadius: 99, background: BRAND.grayLight, fontSize: 11, fontWeight: 600, color: BRAND.textMuted, marginBottom: 8 }}>
                      ⏳ Employer decides by {new Date(a.shiftStartAt).toLocaleDateString('en-MY', { day: 'numeric', month: 'short' })}, {new Date(a.shiftStartAt).toLocaleTimeString('en-MY', { hour: '2-digit', minute: '2-digit' })}
                    </div>
                  )}
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12 }}>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: 700, fontSize: 14, color: BRAND.text, marginBottom: 2 }}>{a.shiftTitle}</div>
                      <div style={{ fontSize: 12, color: BRAND.textMuted }}>{a.employer} · {a.date}</div>
                    </div>
                    <Pill
                      label={a.shiftStatus === "cancelled" ? "Shift Cancelled" : a.status === "shortlisted" ? "Shortlisted" : a.status === "accepted" ? "Accepted" : a.status === "rejected" ? "Not selected" : "Pending"}
                      color={a.shiftStatus === "cancelled" ? "red" : a.status === "shortlisted" ? "amber" : a.status === "accepted" ? "green" : "gray"}
                    />
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <div>
                      <span style={{ fontSize: 13, color: BRAND.textMuted }}>Your bid: </span>
                      <span style={{ fontSize: 15, fontWeight: 700, color: BRAND.text }}>RM{a.wageBid}/h</span>
                    </div>
                    {a.status === "shortlisted" && (
                      <Btn size="sm" onClick={(e) => { e.stopPropagation(); setTab('chat'); }}>Chat →</Btn>
                    )}
                    {a.status === "accepted" && (
                      <Btn size="sm" variant="success" onClick={(e) => { e.stopPropagation(); setShowQR(true); }}>Check In</Btn>
                    )}
                  </div>
                  {a.status === "shortlisted" && (
                    <div style={{ marginTop: 12, padding: "8px 12px", background: BRAND.amberLight, borderRadius: 8, fontSize: 12, color: BRAND.amber }}>
                      🎉 You've been shortlisted! Open chat to discuss and receive your offer.
                    </div>
                  )}
                  {a.status === 'accepted' && !a.workerSignedAt && (
                    <button onClick={(e) => { e.stopPropagation(); setWorkerContractModal({
                        applicationId: a.id,
                        shiftTitle: a.shiftTitle,
                        shiftDate: a.date,
                        wageAsk: a.wageBid,
                        employerName: a.employer,
                      }); }}
                      style={{marginTop:6, padding:'6px 14px', borderRadius:6, background:'#2563EB', color:'#fff', border:'none', cursor:'pointer', fontSize:12, fontWeight:600}}>
                      ✍️ Sign Contract
                    </button>
                  )}
                  {a.status === 'accepted' && a.workerSignedAt && (
                    <span style={{fontSize:11, color:'#16a34a', marginTop:4, display:'block'}}>✅ Contract signed</span>
                  )}
                </Card>
              ))}
            </div>
          </div>
        )}

        {tab === "applications" && user && selectedApplication && (() => {
          const a = selectedApplication;
          return (
          <div>
            <button onClick={() => setSelectedApplication(null)} style={{ background: "none", border: "none", cursor: "pointer", fontSize: 14, color: BRAND.primary, fontFamily: "inherit", marginBottom: 16 }} aria-label="Back to my bids">{Icons.ArrowLeft({ size: 14 })} <span style={{ marginLeft: 8 }}>Back to My Bids</span></button>
            {a.status === "pending" && a.shiftStartAt && a.shiftStatus !== "cancelled" && (
              <div style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "3px 10px", borderRadius: 99, background: BRAND.grayLight, fontSize: 12, fontWeight: 600, color: BRAND.textMuted, marginBottom: 10 }}>
                ⏳ Employer decides by {new Date(a.shiftStartAt).toLocaleDateString('en-MY', { day: 'numeric', month: 'short', year: 'numeric' })}, {new Date(a.shiftStartAt).toLocaleTimeString('en-MY', { hour: '2-digit', minute: '2-digit' })}
              </div>
            )}
            <div style={{ fontSize: 20, fontWeight: 800, color: BRAND.text, marginBottom: 4 }}>{a.shiftTitle}</div>
            <div style={{ display: "flex", gap: 8, marginBottom: 20 }}>
              <Pill
                label={a.shiftStatus === "cancelled" ? "Shift Cancelled" : a.status === "shortlisted" ? "Shortlisted" : a.status === "accepted" ? "Accepted" : a.status === "rejected" ? "Not selected" : "Pending"}
                color={a.shiftStatus === "cancelled" ? "red" : a.status === "shortlisted" ? "amber" : a.status === "accepted" ? "green" : "gray"}
              />
              {a.shiftCategory && <Badge color="amber">{a.shiftCategory}</Badge>}
            </div>
            {a.shiftStatus === "cancelled" && (
              <div style={{ padding: "10px 14px", background: "#FEF2F2", border: "1px solid #FCA5A5", borderRadius: 10, fontSize: 12, color: BRAND.red, marginBottom: 16 }}>
                This shift was cancelled by the employer. No further action is needed.
              </div>
            )}
            {a.shiftDescription && (
              <Card style={{ marginBottom: 16 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: BRAND.text, marginBottom: 8 }}>{t("shiftDetail.aboutRole")}</div>
                <div style={{ fontSize: 13, color: BRAND.text, lineHeight: 1.6, whiteSpace: "pre-wrap" }}>{a.shiftDescription}</div>
              </Card>
            )}
            <Card style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: BRAND.text, marginBottom: 12 }}>Shift Details</div>
              {[
                ["📍 Location", a.shiftLocation || "TBA"],
                ["🗓 Date", a.date],
                ["⏰ Time", a.shiftStartAt && a.shiftEndAt ? `${new Date(a.shiftStartAt).toLocaleTimeString('en-MY', { hour: '2-digit', minute: '2-digit' })}–${new Date(a.shiftEndAt).toLocaleTimeString('en-MY', { hour: '2-digit', minute: '2-digit' })}` : 'TBA'],
                ["👗 Dress code", a.shiftDress || "None specified"],
                ["👥 Headcount", `${a.shiftHeadcount} workers needed`],
                ["💰 Employer range", a.shiftWageMin && a.shiftWageMax ? `RM${a.shiftWageMin}–${a.shiftWageMax}/h` : "N/A"],
                ["🚌 Transport allowance", a.shiftStipend > 0 ? `RM${a.shiftStipend}` : "Not provided"],
                ["Your bid", `RM${a.wageBid}/h`],
              ].map(([k, v]) => (
                <div key={k} style={{ display: "flex", gap: 8, marginBottom: 8 }}>
                  <span style={{ fontSize: 13, color: BRAND.textMuted, width: 150, flexShrink: 0 }}>{k}</span>
                  <span style={{ fontSize: 13, color: BRAND.text, fontWeight: 500 }}>{v}</span>
                </div>
              ))}
            </Card>
            {a.status === "shortlisted" && (
              <div style={{ padding: "10px 14px", background: BRAND.amberLight, borderRadius: 10, fontSize: 12, color: BRAND.amber, marginBottom: 16 }}>
                🎉 You've been shortlisted! Open chat to discuss and receive your offer.
              </div>
            )}
            <div style={{ display: "flex", gap: 10 }}>
              {a.status === "pending" && a.shiftStatus !== "cancelled" && (
                <Btn variant="secondary" disabled={cancellingBid} onClick={() => cancelBid(a.id)} style={{ flex: 1, justifyContent: "center", color: BRAND.red }}>
                  {cancellingBid ? "Cancelling…" : "Cancel Bid"}
                </Btn>
              )}
              {a.status === "shortlisted" && a.shiftStatus !== "cancelled" && (
                <Btn onClick={() => setTab('chat')} style={{ flex: 1, justifyContent: "center" }}>Chat →</Btn>
              )}
              {a.status === "accepted" && !a.workerSignedAt && a.shiftStatus !== "cancelled" && (
                <Btn onClick={() => setWorkerContractModal({ applicationId: a.id, shiftTitle: a.shiftTitle, shiftDate: a.date, wageAsk: a.wageBid, employerName: a.employer })} style={{ flex: 1, justifyContent: "center" }}>✍️ Sign Contract</Btn>
              )}
              {a.status === "accepted" && a.workerSignedAt && a.shiftStatus !== "cancelled" && (
                <Btn variant="success" onClick={() => setShowQR(true)} style={{ flex: 1, justifyContent: "center" }}>Check In</Btn>
              )}
            </div>
          </div>
          );
        })()}

        {tab === 'chat' && !user && (
          <AuthGate
            onRequireAuth={onRequireAuth}
            icon="💬"
            title={t("chat.signInTitle")}
            hint={t("chat.signInHint")}
          />
        )}

        {tab === 'chat' && user && (
          <div style={{padding:'0 0 80px'}}>
            <h2 style={{fontSize:18, fontWeight:700, color:'#1e293b', margin:'16px 0 12px'}}>{t("chat.title")}</h2>
            {!activeChatShift ? (
              chatConversations.length === 0 ? (
                <div style={{textAlign:'center', color:'#94a3b8', marginTop:48}}>
                  <div style={{fontSize:40}}>💬</div>
                  <div style={{marginTop:8}}>{t("chat.emptyTitleWorker")}</div>
                  <div style={{fontSize:12, marginTop:4}}>{t("chat.emptyHintWorker")}</div>
                </div>
              ) : (
                chatConversations.map(conv => (
                  <div key={conv.shiftId} onClick={() => setActiveChatShift(conv)}
                    style={{padding:14, background:'#fff', borderRadius:10, border:'1px solid #e2e8f0',
                      marginBottom:10, cursor:'pointer', display:'flex', justifyContent:'space-between', alignItems:'center'}}>
                    <div>
                      <div style={{fontWeight:600, color:'#1e293b'}}>{conv.title}</div>
                      <div style={{fontSize:12, color:'#64748b'}}>{conv.date} · {conv.otherUserLabel}</div>
                    </div>
                    <span style={{color:'#94a3b8'}}>›</span>
                  </div>
                ))
              )
            ) : (
              <div style={{display:'flex', flexDirection:'column', height:'calc(100vh - 200px)'}}>
                <div style={{display:'flex', alignItems:'center', gap:8, marginBottom:12}}>
                  <button onClick={() => { setActiveChatShift(null); setChatMessages([]); }}
                    style={{background:'none', border:'none', cursor:'pointer', fontSize:18, color:'#2563EB'}}>←</button>
                  <div>
                    <div style={{fontWeight:600, color:'#1e293b'}}>{activeChatShift.title}</div>
                    <div style={{fontSize:12, color:'#64748b'}}>{activeChatShift.otherUserLabel}</div>
                  </div>
                </div>
                <div style={{flex:1, overflowY:'auto', display:'flex', flexDirection:'column', gap:8, paddingBottom:8}}>
                  {chatLoading && <div style={{textAlign:'center', color:'#94a3b8', padding:16}}>{t("chat.loading")}</div>}
                  {chatMessages.map(msg => {
                    const isMe = msg.sender_id === user.id;
                    return (
                      <div key={msg.id} style={{display:'flex', justifyContent: isMe ? 'flex-end' : 'flex-start'}}>
                        <div style={{maxWidth:'75%', padding:'8px 12px', borderRadius: isMe ? '12px 12px 2px 12px' : '12px 12px 12px 2px',
                          background: isMe ? '#2563EB' : '#f1f5f9', color: isMe ? '#fff' : '#1e293b', fontSize:14}}>
                          <div>{msg.content}</div>
                          <div style={{fontSize:10, opacity:0.6, marginTop:2, textAlign:'right'}}>
                            {new Date(msg.created_at).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
                <div style={{display:'flex', gap:8, paddingTop:8, borderTop:'1px solid #e2e8f0'}}>
                  <input
                    value={chatInput} onChange={e => setChatInput(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && !e.shiftKey && sendMessage()}
                    placeholder={t("chat.inputPlaceholder")}
                    style={{flex:1, padding:'10px 12px', borderRadius:8, border:'1px solid #e2e8f0', fontSize:14}}
                  />
                  <button onClick={sendMessage}
                    style={{padding:'10px 16px', borderRadius:8, background:'#2563EB', color:'#fff', border:'none', cursor:'pointer', fontWeight:600}}>
                    {t("chat.send")}
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {tab === "earnings" && !user && (
          <AuthGate
            onRequireAuth={onRequireAuth}
            icon="💸"
            title="Sign in to view earnings"
            hint="Track your payouts, internal settlement status, and bank verification once you're signed in."
          />
        )}

        {tab === "earnings" && user && (
          <div>
            <div style={{ fontSize: isMobile ? 18 : 20, fontWeight: 800, color: BRAND.text, marginBottom: 4 }}>{t("earnings.title")}</div>
            <div style={{ fontSize: isMobile ? 12 : 13, color: BRAND.textMuted, marginBottom: 16 }}>{t("earnings.subtitle")}</div>
            <div style={{ background: `linear-gradient(135deg, ${BRAND.primary}, ${BRAND.primaryDark})`, borderRadius: 20, padding: isMobile ? 18 : 24, marginBottom: 20, color: "#fff" }}>
              <div style={{ fontSize: isMobile ? 11 : 12, opacity: 0.8, marginBottom: 8 }}>{t("earnings.totalPayouts")}</div>
              <div style={{ fontSize: isMobile ? 32 : 38, fontWeight: 900, marginBottom: 4 }}>{toCurrency(totalEarned)}</div>
              <div style={{ fontSize: isMobile ? 12 : 13, opacity: 0.8 }}>
                {payoutEligibility ? t("earnings.verified") : t("earnings.notVerified")}
              </div>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr 1fr" : "1fr 1fr", gap: 10, marginBottom: 20 }}>
              <Stat label={t("earnings.statRecords")} value={String(payoutRows.length)} color={BRAND.primary} />
              <Stat label={t("earnings.statReady")} value={String(payoutRows.filter(p => p.status === "ready").length)} color={BRAND.green} />
              <Stat label={t("earnings.statHeld")} value={String(payoutRows.filter(p => p.status === "held").length)} color={BRAND.red} />
              <Stat label={t("earnings.statBanking")} value={workerBanking?.verification_status || "pending"} sub="SecureSign" color={BRAND.blue} />
            </div>
            <div style={{ fontSize: isMobile ? 13 : 15, fontWeight: 700, color: BRAND.text, marginBottom: 12 }}>{t("earnings.recentPayouts")}</div>
            {payoutsLoading ? (
              <>
                <SkeletonRow />
                <SkeletonRow />
                <SkeletonRow />
              </>
            ) : payoutRows.length === 0 ? (
              <EmptyState
                icon="💸"
                title={t("earnings.noPayoutsTitle")}
                hint={t("earnings.noPayoutsHint")}
              />
            ) : (
              payoutRows.map((p) => (
                <Card key={p.id} style={{ marginBottom: 10, padding: "14px 16px" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <div>
                      <div style={{ fontWeight: 600, fontSize: 13, color: BRAND.text }}>{p.shift}</div>
                      <div style={{ fontSize: 12, color: BRAND.textMuted, marginTop: 2 }}>{p.date} · {p.travel > 0 ? `+RM${p.travel} travel` : t("earnings.salaryPayout")}</div>
                    </div>
                    <div style={{ textAlign: "right" }}>
                      <div style={{ fontWeight: 800, fontSize: 16, color: BRAND.green }}>+{toCurrency(p.amount)}</div>
                      <Pill label={String(p.status || "queued").replaceAll("_", " ")} color={mapPayoutPillColor(p.status)} />
                    </div>
                  </div>
                </Card>
              ))
            )}
          </div>
        )}

        {tab === "profile" && !user && (
          <AuthGate
            onRequireAuth={onRequireAuth}
            icon="👤"
            title={t("profile.signInTitle")}
            hint={t("profile.signInHint")}
          />
        )}

        {tab === "profile" && user && (
          <div>
            <div style={{ textAlign: "center", padding: isMobile ? "12px 0 16px" : "20px 0 24px" }}>
              <div style={{ display: "inline-block", position: "relative" }}>
                <Avatar name={profileName} size={isMobile ? 56 : 72} color={BRAND.primary} src={getAvatarUrl(user.user_metadata?.avatar_url)} />
                <label style={{
                  position: "absolute", right: -2, bottom: -2, width: 26, height: 26,
                  borderRadius: "50%", background: BRAND.primary, color: "#fff",
                  display: "flex", alignItems: "center", justifyContent: "center",
                  cursor: avatarUploading ? "wait" : "pointer", fontSize: 13,
                  border: `2px solid ${BRAND.surface}`,
                }} title={t("profile.changePhoto")}>
                  {avatarUploading ? "…" : "✎"}
                  <input type="file" accept="image/*" disabled={avatarUploading}
                    onChange={(e) => handleAvatarUpload(e.target.files?.[0])}
                    style={{ display: "none" }} />
                </label>
              </div>
              <div style={{ fontSize: isMobile ? 18 : 20, fontWeight: 800, color: BRAND.text, marginTop: isMobile ? 8 : 12 }}>{profileName}</div>
              <div style={{ fontSize: isMobile ? 12 : 14, color: BRAND.textMuted }}>{user.email}</div>
              <div style={{ display: "flex", gap: 6, justifyContent: "center", marginTop: 8, flexWrap: "wrap" }}>
                <Badge color="teal">{t("profile.standardKyc")}</Badge>
                <Badge color="green">🛡️ {profileStats.reliability_score}/100 {t("profile.reliabilitySuffix")}</Badge>
              </div>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr 1fr" : "1fr 1fr", gap: 10, marginBottom: 20 }}>
              <Stat label={t("profile.shiftsDone")} value="38" color={BRAND.primary} />
              <Stat label={t("profile.rating")} value={<span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><span>⭐ {(profileStats.rating ?? 0).toFixed(1)}</span></span>} color={BRAND.accent} />
              <Stat label={t("profile.strikes")} value="0" sub={t("profile.cleanRecord")} color={BRAND.green} />
              <Stat label={t("profile.onTimeRate")} value="96%" color={BRAND.blue} />
            </div>
            <Card style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: BRAND.text, marginBottom: 12 }}>{t("profile.kycVerification")}</div>
              {[{ tier: t("profile.kycBasic"), status: "verified" }, { tier: t("profile.kycStandard"), status: "verified" }, { tier: t("profile.kycAdvanced"), status: "not started" }].map((v, i) => (
                <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 0", borderBottom: i < 2 ? `1px solid ${BRAND.border}` : "none" }}>
                  <span style={{ fontSize: 13, color: BRAND.text }}>{v.tier}</span>
                  <Pill label={v.status === "verified" ? t("profile.verified") : "—"} color={v.status === "verified" ? "green" : "gray"} />
                </div>
              ))}
            </Card>
            <Card style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: BRAND.text, marginBottom: 4 }}>{t("profile.reliabilityScoreLabel")}{profileStats.reliability_score}</div>
              <Progress value={Math.min(100, Math.max(0, profileStats.reliability_score))} color={profileStats.reliability_score > 90 ? BRAND.green : profileStats.reliability_score > 75 ? BRAND.accent : BRAND.red} />
              <div style={{ fontSize: 12, color: BRAND.textMuted, marginTop: 8 }}>{profileStats.reliability_score >= 90 ? t("profile.reliabilityExcellent") :
 profileStats.reliability_score >= 75 ? t("profile.reliabilityGood") :
 profileStats.reliability_score >= 50 ? t("profile.reliabilityBuilding") :
 t("profile.reliabilityLow")}</div>
            </Card>
            <Card>
              <div style={{ fontSize: 14, fontWeight: 700, color: BRAND.text, marginBottom: 12 }}>{t("profile.recentRatings")}</div>
              <EmptyState icon="⭐" title={t("profile.noRatingsTitle")} hint={t("profile.noRatingsHint")} />
            </Card>
          </div>
        )}

        {tab === "settings" && (
          <div>
            <div style={{ fontSize: isMobile ? 18 : 20, fontWeight: 800, color: BRAND.text, marginBottom: 4 }}>{t("settings.title")}</div>
            <div style={{ fontSize: isMobile ? 12 : 13, color: BRAND.textMuted, marginBottom: 16 }}>{t("settings.subtitle")}</div>
            <Card style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: BRAND.text, marginBottom: 12 }}>{t("settings.account")}</div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 0", borderBottom: `1px solid ${BRAND.border}` }}>
                <span style={{ fontSize: 13, color: BRAND.textMuted }}>{t("settings.language")}</span>
                <div style={{ display: "flex", gap: 6 }}>
                  <Btn
                    size="xs"
                    variant={language === "en" ? "primary" : "secondary"}
                    onClick={() => setLanguage("en")}
                    aria-pressed={language === "en"}
                  >
                    {t("settings.languageEnglish")}
                  </Btn>
                  <Btn
                    size="xs"
                    variant={language === "bm" ? "primary" : "secondary"}
                    onClick={() => setLanguage("bm")}
                    aria-pressed={language === "bm"}
                  >
                    {t("settings.languageBM")}
                  </Btn>
                </div>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", padding: "8px 0", borderBottom: `1px solid ${BRAND.border}` }}>
                <span style={{ fontSize: 13, color: BRAND.textMuted }}>{t("settings.notifications")}</span>
                <span style={{ fontSize: 13, fontWeight: 600, color: BRAND.text }}>{t("settings.notificationsValue")}</span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", padding: "8px 0" }}>
                <span style={{ fontSize: 13, color: BRAND.textMuted }}>{t("settings.privacy")}</span>
                <span style={{ fontSize: 13, fontWeight: 600, color: BRAND.text }}>{t("settings.privacyValue")}</span>
              </div>
            </Card>
            {!user && (
              <Card style={{ marginBottom: 16 }}>
                <div style={{ fontSize: 14, fontWeight: 700, color: BRAND.text, marginBottom: 4 }}>Salary Banking Details</div>
                <AuthGate
                  onRequireAuth={onRequireAuth}
                  icon="🏦"
                  title="Sign in to manage banking"
                  hint="Add and verify your bank details for salary payouts after signing in."
                />
              </Card>
            )}
            {user && (
            <Card style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: BRAND.text, marginBottom: 4 }}>{t("settings.salaryBankingTitle")}</div>
              <div style={{ fontSize: 12, color: BRAND.textMuted, marginBottom: 12 }}>
                {t("settings.salaryBankingHint")}
              </div>
              <Select
                label={t("settings.bankLabel")}
                value={workerBankForm.bankName}
                onChange={(e) => setWorkerBankForm((prev) => ({ ...prev, bankName: e.target.value }))}
                options={MALAYSIAN_BANK_OPTIONS.map((name) => ({ value: name, label: name }))}
              />
              <Input
                label={t("settings.accountHolderName")}
                placeholder="As per bank account"
                value={workerBankForm.accountHolderName}
                onChange={(e) => setWorkerBankForm((prev) => ({ ...prev, accountHolderName: e.target.value }))}
              />
              <Input
                label={t("settings.accountNumber")}
                placeholder="Enter bank account number"
                value={workerBankForm.accountNumber}
                onChange={(e) => setWorkerBankForm((prev) => ({ ...prev, accountNumber: e.target.value }))}
              />
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
                <span style={{ fontSize: 12, color: BRAND.textMuted }}>{t("settings.status")}</span>
                <Pill
                  label={workerBanking?.verification_status ? `SecureSign ${workerBanking.verification_status}` : "SecureSign pending"}
                  color={mapVerificationPillColor(workerBanking?.verification_status)}
                />
              </div>
              {workerBanking?.account_number_last4 && (
                <div style={{ fontSize: 12, color: BRAND.textMuted, marginBottom: 12 }}>
                  Saved account: •••• {workerBanking.account_number_last4}
                </div>
              )}
              {bankingMessage && <div style={{ fontSize: 12, color: BRAND.textMuted, marginBottom: 10 }}>{bankingMessage}</div>}
              <div style={{ display: "flex", gap: 8 }}>
                <Btn variant="secondary" onClick={saveWorkerBankingDetails} disabled={bankingLoading} style={{ flex: 1, justifyContent: "center" }}>{t("settings.saveBanking")}</Btn>
                <Btn onClick={verifyWorkerBankingDetails} disabled={bankingLoading} style={{ flex: 1, justifyContent: "center" }}>{t("settings.verifySecureSign")}</Btn>
              </div>
            </Card>
            )}
            {(() => {
              const isAdminAccount = user?.app_metadata?.role === "admin";
              const canSeeEmployer = userRole === "employer" || isAdminAccount;
              if (!canSeeEmployer && !isAdminAccount) return null;
              return (
                <Card style={{ marginBottom: 16 }}>
                  <div style={{ fontSize: 14, fontWeight: 700, color: BRAND.text, marginBottom: 8 }}>Access other consoles</div>
                  <div style={{ fontSize: 12, color: BRAND.textMuted, marginBottom: 14 }}>These are hidden from the main app and can only be opened here.</div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                    {canSeeEmployer && <Btn variant="secondary" onClick={() => onOpenPortal?.("employer")}>Open Employer Console</Btn>}
                    {isAdminAccount && <Btn variant="secondary" onClick={() => onOpenPortal?.("admin")}>Open Admin Dashboard</Btn>}
                  </div>
                </Card>
              );
            })()}

            {/* Terms & Conditions — Malaysian Labor Law */}
            <div style={{marginTop:24, borderTop:'1px solid #e2e8f0', paddingTop:16}}>
              <button
                onClick={() => setShowTnC(v => !v)}
                style={{display:'flex', alignItems:'center', justifyContent:'space-between', width:'100%',
                  background:'none', border:'none', cursor:'pointer', padding:0, textAlign:'left'}}
              >
                <span style={{fontSize:14, fontWeight:600, color:'#374151'}}>
                  📋 Terms & Conditions — Malaysian Labor Law
                </span>
                <span style={{fontSize:12, color:'#6b7280'}}>{showTnC ? '▲ Hide' : '▼ Show'}</span>
              </button>

              {showTnC && (
                <div style={{marginTop:12, fontSize:13, color:'#374151', lineHeight:1.7}}>
                  <p style={{color:'#6b7280', fontSize:12, marginBottom:12}}>
                    ⚠️ This is a summary for general guidance only. Consult a Malaysian employment lawyer before making decisions. Last updated: June 2026.
                  </p>

                  {[
                    {
                      title: '1. Employment Act Coverage',
                      body: 'Since the 2022 amendments (in force 1 Jan 2023), ALL employees in Peninsular Malaysia are covered regardless of salary. Workers earning below RM4,000/month are entitled to overtime pay (1.5×), rest day premiums (2×), and public holiday premiums (3×). Casual/single-shift workers are covered from their first day of work, though annual leave and sick leave require at least 1 month of continuous service with the same employer.'
                    },
                    {
                      title: '2. EPF (KWSP) — Employees Provident Fund',
                      body: 'EPF contributions are mandatory for any employee under a contract of service, from their very first day — there is no minimum hours or days threshold. Rates (2025–2026): Employer 13% + Employee 11% for wages ≤ RM5,000/month. Employer 12% + Employee 11% for wages > RM5,000/month. Foreign workers: Employer 2% + Employee 2% (from Oct 2025). EPF obligations belong to the hiring business, not to CariGaji as a marketplace platform.'
                    },
                    {
                      title: '3. SOCSO (PERKESO) — Social Security',
                      body: 'SOCSO is mandatory from an employee\'s first day of work. Wage ceiling is RM6,000/month (from Oct 2024). Rates: Employer 1.75% + Employee 0.5% (below age 60). SOCSO covers workplace injuries under the Employment Injury Scheme from Day 1, and invalidity from non-work causes for workers below age 60. The hiring business on CariGaji is responsible for registering and contributing SOCSO for their workers.'
                    },
                    {
                      title: '4. EIS — Employment Insurance System',
                      body: 'EIS applies to Malaysian/PR employees aged 18–60. Rate: 0.2% employer + 0.2% employee (wage ceiling RM6,000). EIS provides income replacement of up to 80% of wages for up to 6 months if a worker is retrenched. Contributions are legally required for casual workers, though practical EIS benefits are limited for workers on single-shift engagements who are simply not re-engaged. EIS does not apply to foreign workers.'
                    },
                    {
                      title: '5. Income Tax',
                      body: 'Workers must file a tax return if annual income exceeds RM34,000 after EPF deductions (approximately RM2,833/month gross). The first RM5,000 of chargeable income is taxed at 0%. After standard personal reliefs (RM9,000 automatic + up to RM4,000 EPF relief), most shift workers earning below RM3,500/month will pay zero or minimal income tax. Workers with income from multiple employers or gig jobs must declare all income on a single combined return via MyTax (mytax.hasil.gov.my). Non-residents (present in Malaysia fewer than 182 days/year) are taxed at a flat 30% rate.'
                    },
                    {
                      title: '6. Gig Workers Act 2025 (Act 872) ⭐ New Law',
                      body: 'The Gig Workers Act 2025 (Act 872) came into force on 31 March 2026, creating a new legal category between employee and independent contractor. Under Act 872, platform providers (digital intermediaries connecting gig workers to service users — which may include CariGaji) must: register gig workers with PERKESO; deduct and remit 1.25% of each transaction to PERKESO under the self-employment social security scheme; provide written service agreements; and integrate payment systems with PERKESO. EPF is not required for gig workers under Act 872. Non-compliance penalties: up to 2 years imprisonment or RM10,000 fine. CariGaji is currently seeking legal advice on its classification under this Act.'
                    },
                    {
                      title: '7. Minimum Wage (2025)',
                      body: 'The minimum wage in Malaysia is RM1,700/month or RM8.72/hour (effective August 2025 for all employers). This applies to all workers including casual and short-term shift workers. No exceptions exist for gig or platform workers. Employers on CariGaji must not post shifts with a wage below RM8.72/hour.'
                    },
                    {
                      title: '8. Working Hours & Overtime',
                      body: 'Maximum working hours are 8 hours per day and 45 hours per week. No single day may exceed 12 hours including overtime. Maximum overtime is 104 hours per month. For employees earning below RM4,000/month, overtime on a normal day is paid at 1.5× the hourly rate; work on a rest day at 2× the daily rate; work on a public holiday at 3× the hourly rate. These protections apply to shift workers from their first day of employment.'
                    },
                    {
                      title: '9. What Short-Term Workers May Not Receive',
                      body: 'Annual leave (8–16 days/year), sick leave (14–22 days/year), and hospitalisation leave (60 days/year) require at least 1 month of continuous service with the same employer — a one-off or infrequent shift engagement may not qualify. Maternity leave (98 days) requires an ongoing employment relationship. Paternity leave (7 days) requires at least 12 months of continuous service. EPF and SOCSO contributions are legally due from Day 1 regardless of how short the engagement is.'
                    },
                    {
                      title: '10. Platform Liability — CariGaji\'s Role',
                      body: 'CariGaji operates as a technology marketplace connecting employers and workers. The legal employment relationship — and the resulting EPF, SOCSO, EIS, minimum wage, and Employment Act obligations — is between the worker and the hiring business, not between the worker and CariGaji. CariGaji does not set hours, direct how work is performed, or pay wages directly. Employers using CariGaji are responsible for complying with all applicable Malaysian employment laws. CariGaji is separately assessing its obligations as a potential platform provider under the Gig Workers Act 2025 (Act 872). This summary does not constitute legal advice.'
                    },
                  ].map(({ title, body }) => (
                    <div key={title} style={{marginBottom:14, paddingBottom:14, borderBottom:'1px solid #f1f5f9'}}>
                      <div style={{fontWeight:600, marginBottom:4, color:'#1e293b'}}>{title}</div>
                      <div style={{color:'#475569'}}>{body}</div>
                    </div>
                  ))}

                  <p style={{fontSize:11, color:'#94a3b8', marginTop:8}}>
                    References: Employment Act 1955 (Act 265) · EPF Act 1991 (Act 452) · SOCSO Act 1969 (Act 4) · EIS Act 2017 (Act 800) · Gig Workers Act 2025 (Act 872) · Minimum Wages Act 2012 (Act 732) · Income Tax Act 1967 (Act 53)
                  </p>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Bottom nav */}
      <div style={navBarStyle}>
        {navItems.map(n => (
          <button key={n.id} onClick={() => setTab(n.id)} style={{
            flex: isMobile ? 1 : "0 0 auto", padding: isMobile ? "6px 0" : "8px 18px", border: "none", background: "none", cursor: "pointer",
            display: "flex", flexDirection: isMobile ? "column" : "row", alignItems: "center", gap: isMobile ? 2 : 8,
            borderRadius: isMobile ? 0 : 8,
            color: tab === n.id ? BRAND.primary : BRAND.textMuted,
            fontFamily: "inherit",
          }}>
            <span style={{ fontSize: isMobile ? 16 : 18, lineHeight: 1 }}>{n.icon}</span>
            <span style={{ fontSize: isMobile ? 9 : 14, fontWeight: tab === n.id ? 700 : 500, whiteSpace: "nowrap" }}>{n.label}</span>
          </button>
        ))}
      </div>
    </div>

    {workerContractModal && (
      <div style={{position:'fixed', inset:0, background:'rgba(0,0,0,0.6)', zIndex:1100, display:'flex', alignItems:'center', justifyContent:'center', padding:16}}>
        <div style={{background:'#fff', borderRadius:16, padding:24, maxWidth:480, width:'100%', maxHeight:'85vh', overflowY:'auto'}}>
          <h3 style={{fontSize:18, fontWeight:700, color:'#1e293b', marginBottom:4}}>📄 Your Employment Contract</h3>
          <p style={{fontSize:12, color:'#6b7280', marginBottom:16}}>Please read carefully before signing.</p>

          <div style={{background:'#f8fafc', borderRadius:8, padding:16, fontSize:13, lineHeight:1.8, color:'#374151', marginBottom:16}}>
            <p><strong>CariGaji Platform — Shift Work Agreement</strong></p>
            <p>• <strong>Employer:</strong> {workerContractModal.employerName}</p>
            <p>• <strong>Worker:</strong> You</p>
            <p>• <strong>Role:</strong> {workerContractModal.shiftTitle}</p>
            <p>• <strong>Date:</strong> {workerContractModal.shiftDate}</p>
            <p>• <strong>Agreed wage:</strong> RM {workerContractModal.wageAsk}/hr</p>
            <br/>
            <p><strong>By signing you agree to:</strong></p>
            <p>1. Attend the shift punctually and perform the assigned duties.</p>
            <p>2. Accept the agreed wage as full payment for hours worked.</p>
            <p>3. Notify the employer promptly if you are unable to attend.</p>
            <p>4. Comply with the employer's workplace rules and safety requirements.</p>
            <p>5. This is a casual short-term engagement. You are responsible for declaring your own income tax to LHDN if applicable.</p>
            <p>6. CariGaji acts as a marketplace intermediary and is not your employer.</p>
            <p>7. Governed by Malaysian law including the Employment Act 1955.</p>
          </div>

          <div style={{display:'flex', gap:8}}>
            <button onClick={() => setWorkerContractModal(null)}
              style={{flex:1, padding:'10px', borderRadius:8, border:'1px solid #e2e8f0', background:'#f8fafc', cursor:'pointer', color:'#64748b'}}>
              Cancel
            </button>
            <button onClick={async () => {
              const { error } = await supabase
                .from('applications')
                .update({ worker_signed_at: new Date().toISOString() })
                .eq('id', workerContractModal.applicationId);
              if (error) { toast(t('toast.signFailed') + error.message, 'error'); return; }
              toast(t('toast.contractSigned'), 'success');
              setLiveApplications(prev => prev.map(a =>
                a.id === workerContractModal.applicationId ? { ...a, workerSignedAt: new Date().toISOString() } : a
              ));
              setWorkerContractModal(null);
            }}
              style={{flex:2, padding:'10px', borderRadius:8, background:'#2563EB', color:'#fff', border:'none', cursor:'pointer', fontWeight:600}}>
              ✍️ I have read and agree — Sign
            </button>
          </div>
        </div>
      </div>
    )}
    </>
  );
};

// ─── EMPLOYER PORTAL ─────────────────────────────────────────────────────────
const EmployerPortal = ({ onOpenPortal, compact = false, user = null }) => {
  const toast = useToast();
  const { t } = useLanguage();
  const [view, setView] = useState("dashboard");
  const [selectedShift, setSelectedShift] = useState(null);
  const [liveApplicants, setLiveApplicants] = useState(null);
  const [postStep, setPostStep] = useState(1);
  const [editingShiftId, setEditingShiftId] = useState(null);
  const [cancellingShift, setCancellingShift] = useState(false);
  const [form, setForm] = useState({ title: "", category: "F&B", date: "", timeStart: "", timeEnd: "", wageMin: "", wageMax: "", headcount: 1, dress: "", location: "KLCC, KL City Centre", addressVisibility: "public", offersTransportAllowance: false, transportAllowance: "", description: "" });
  const [applicantAction, setApplicantAction] = useState({});
  const [liveEmployerShifts, setLiveEmployerShifts] = useState(null);
  const [employerProfile, setEmployerProfile] = useState(null);
  const [recentActivity, setRecentActivity] = useState([]);
  const [employerBanking, setEmployerBanking] = useState(null);
  const [employerBankForm, setEmployerBankForm] = useState({
    bankName: MALAYSIAN_BANK_OPTIONS[0],
    accountHolderName: "",
    accountNumber: "",
    fundingReady: false,
  });
  const [bankingMessage, setBankingMessage] = useState("");
  const [bankingLoading, setBankingLoading] = useState(false);
  const [employerPayoutItems, setEmployerPayoutItems] = useState([]);
  const [contractModal, setContractModal] = useState(null);
  const [chatConversations, setChatConversations] = useState([]);
  const [activeChatShift, setActiveChatShift] = useState(null);
  const [chatMessages, setChatMessages] = useState([]);
  const [chatInput, setChatInput] = useState('');
  const [chatLoading, setChatLoading] = useState(false);

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

  // Employer's own profile (real name + reliability score for the dashboard
  // greeting/stats — replaces the old hardcoded "Grand Hyatt KL" demo copy).
  useEffect(() => {
    let active = true;
    if (!user) { setEmployerProfile(null); return; }
    supabase.from('profiles').select('full_name, reliability_score').eq('id', user.id).maybeSingle()
      .then(({ data }) => { if (active) setEmployerProfile(data ?? null); });
    return () => { active = false; };
  }, [user]);

  // Real applicant counts per shift + a recent-activity feed, both computed
  // from live applications data (no mock numbers).
  useEffect(() => {
    let active = true;
    const shiftIds = (liveEmployerShifts ?? []).map(s => s.id);
    if (shiftIds.length === 0) { setRecentActivity([]); return; }
    supabase
      .from('applications')
      .select('id, wage_ask, status, applied_at, shift_id, worker:profiles(full_name)')
      .in('shift_id', shiftIds)
      .order('applied_at', { ascending: false })
      .then(({ data, error }) => {
        if (!active || error) return;
        const rows = data ?? [];
        const counts = {};
        rows.forEach(a => { counts[a.shift_id] = (counts[a.shift_id] || 0) + 1; });
        setLiveEmployerShifts(prev => (prev ?? []).map(s => ({ ...s, applicants: counts[s.id] || 0 })));
        setRecentActivity(rows.slice(0, 5).map(a => {
          const shiftTitle = (liveEmployerShifts ?? []).find(s => s.id === a.shift_id)?.title || 'a shift';
          const who = a.worker?.full_name || 'A worker';
          if (a.status === 'accepted') return `${who} was accepted for ${shiftTitle}`;
          if (a.status === 'rejected') return `${who}'s bid for ${shiftTitle} was declined`;
          return `${who} bid RM${a.wage_ask}/h for ${shiftTitle}`;
        }));
      });
    return () => { active = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveEmployerShifts === null ? null : liveEmployerShifts.map(s => s.id).join(',')]);

  // Start a fresh shift post (clears any edit state + form).
  const beginNewShift = () => {
    setEditingShiftId(null);
    setSelectedShift(null);
    setForm({ title: "", category: "F&B", date: "", timeStart: "", timeEnd: "", wageMin: "", wageMax: "", headcount: 1, dress: "", location: "", addressVisibility: "public", offersTransportAllowance: false, transportAllowance: "", description: "" });
    setView("postshift");
    setPostStep(1);
  };

  // Load an existing shift into the form for editing.
  const startEditShift = async (shiftId) => {
    const { data, error } = await supabase
      .from('shifts')
      .select('id, title, description, category, location, dress_code, start_at, end_at, wage_min, wage_max, headcount, address_visibility, transport_allowance')
      .eq('id', shiftId)
      .single();
    if (error || !data) { toast('Could not load shift for editing.', 'error'); return; }
    const pad = n => String(n).padStart(2, '0');
    const start = data.start_at ? new Date(data.start_at) : null;
    const end = data.end_at ? new Date(data.end_at) : null;
    const hhmm = d => d ? `${pad(d.getHours())}:${pad(d.getMinutes())}` : '';
    const transportAmt = Number(data.transport_allowance) || 0;
    setForm({
      title: data.title || '',
      description: data.description || '',
      category: data.category || 'F&B',
      date: start ? `${start.getFullYear()}-${pad(start.getMonth() + 1)}-${pad(start.getDate())}` : '',
      timeStart: hhmm(start),
      timeEnd: hhmm(end),
      wageMin: data.wage_min != null ? String(data.wage_min) : '',
      wageMax: data.wage_max != null ? String(data.wage_max) : '',
      headcount: data.headcount || 1,
      dress: data.dress_code || '',
      location: data.location || '',
      addressVisibility: data.address_visibility || 'public',
      offersTransportAllowance: transportAmt > 0,
      transportAllowance: transportAmt > 0 ? String(transportAmt) : '',
    });
    setEditingShiftId(shiftId);
    setSelectedShift(null);
    setView('postshift');
    setPostStep(1);
  };

  useEffect(() => {
    if (!selectedShift?.id || typeof selectedShift.id !== 'string' || !selectedShift.id.includes('-')) return;
    let active = true;
    supabase
      .from('applications')
      .select('id, wage_ask, status, applied_at, worker:profiles(full_name, kyc_level, reliability_score, rating)')
      .eq('shift_id', selectedShift.id)
      .order('applied_at', { ascending: true })
      .then(({ data, error }) => {
        if (!active) return;
        if (error) { console.error('liveApplicants load failed:', error.message); setLiveApplicants([]); return; }
        setLiveApplicants((data ?? []).map(a => ({
          id: a.id,
          name: a.worker?.full_name ?? 'Worker',
          kyc: a.worker?.kyc_level ?? 'Basic',
          reliability: a.worker?.reliability_score ?? 0,
          rating: a.worker?.rating ?? 0,
          wage: Number(a.wage_ask),
          wageBid: Number(a.wage_ask),
          completedShifts: 0,
          status: a.status,
          appliedAt: a.applied_at,
        })));
      });
    return () => { active = false; };
  }, [selectedShift]);

  useEffect(() => {
    if (!user || view !== 'chat') return;
    let active = true;
    supabase
      .from('applications')
      .select('shift_id, worker_id, shift:shifts(id, title, start_at), worker:profiles(full_name)')
      .eq('status', 'accepted')
      .then(({ data }) => {
        if (!active) return;
        setChatConversations((data ?? []).map(a => ({
          shiftId: a.shift_id,
          workerId: a.worker_id,
          title: a.shift?.title ?? 'Shift',
          date: a.shift?.start_at ? new Date(a.shift.start_at).toLocaleDateString('en-MY') : '',
          otherUserId: a.worker_id,
          otherUserLabel: a.worker?.full_name ?? 'Worker',
        })));
      });
    return () => { active = false; };
  }, [user, view]);

  useEffect(() => {
    if (!activeChatShift || !user) return;
    setChatLoading(true);
    let active = true;
    supabase
      .from('messages')
      .select('id, sender_id, content, created_at, read_at')
      .eq('shift_id', activeChatShift.shiftId)
      .order('created_at', { ascending: true })
      .then(({ data }) => {
        if (!active) return;
        setChatMessages(data ?? []);
        setChatLoading(false);
      });
    const channel = supabase
      .channel(`employer-chat-${activeChatShift.shiftId}`)
      .on('postgres_changes', {
        event: 'INSERT',
        schema: 'public',
        table: 'messages',
        filter: `shift_id=eq.${activeChatShift.shiftId}`,
      }, payload => {
        if (active) setChatMessages(prev => [...prev, payload.new]);
      })
      .subscribe();
    return () => {
      active = false;
      supabase.removeChannel(channel);
    };
  }, [activeChatShift, user]);

  const sendMessage = async () => {
    if (!chatInput.trim() || !activeChatShift || !user) return;
    const content = chatInput.trim();
    setChatInput('');
    const { error } = await supabase.from('messages').insert({
      shift_id:     activeChatShift.shiftId,
      sender_id:    user.id,
      recipient_id: activeChatShift.otherUserId,
      content,
    });
    if (error) {
      toast(t('toast.sendFailed') + error.message, 'error');
      setChatInput(content); // restore on failure
    }
  };

  useEffect(() => {
    let active = true;
    const loadEmployerPaymentData = async () => {
      if (!user) {
        setEmployerBanking(null);
        setEmployerPayoutItems([]);
        return;
      }

      const [{ data: bankData, error: bankError }, { data: payoutData, error: payoutError }] = await Promise.all([
        supabase
          .from("banking_details")
          .select("id, bank_name, account_holder_name, account_number_last4, verification_status, funding_ready, verified_at")
          .eq("user_id", user.id)
          .eq("role", "employer")
          .maybeSingle(),
        supabase
          .from("payout_item")
          .select("id, amount, status, scheduled_date, created_at")
          .eq("employer_id", user.id)
          .order("created_at", { ascending: false })
          .limit(100),
      ]);

      if (!active) return;

      if (!bankError) {
        setEmployerBanking(bankData ?? null);
        if (bankData) {
          setEmployerBankForm({
            bankName: bankData.bank_name || MALAYSIAN_BANK_OPTIONS[0],
            accountHolderName: bankData.account_holder_name || "",
            accountNumber: "",
            fundingReady: Boolean(bankData.funding_ready),
          });
        }
      }
      if (!payoutError) setEmployerPayoutItems(payoutData ?? []);
    };

    loadEmployerPaymentData();
    return () => {
      active = false;
    };
  }, [user]);

  const saveEmployerBankingDetails = async () => {
    if (!user) {
      setBankingMessage("Sign in to save banking details.");
      return;
    }
    if (!employerBankForm.accountHolderName.trim() || !employerBankForm.accountNumber.trim()) {
      setBankingMessage("Account holder name and account number are required.");
      return;
    }
    const employerAcctValidation = validateMalaysianBankAccount(employerBankForm.bankName, employerBankForm.accountNumber);
    if (!employerAcctValidation.valid) {
      toast(employerAcctValidation.message, "error");
      return;
    }

    setBankingLoading(true);
    setBankingMessage("");
    const accountDigits = employerBankForm.accountNumber.replace(/\D/g, "");
    const last4 = accountDigits.slice(-4);
    const payload = {
      user_id: user.id,
      role: "employer",
      bank_name: employerBankForm.bankName,
      bank_code: employerBankForm.bankName.toUpperCase().replace(/\s+/g, "_"),
      account_holder_name: employerBankForm.accountHolderName.trim(),
      account_number_last4: last4,
      // Full account number must be encrypted server-side before go-live.
      // Storing masked placeholder here until a backend encryption flow is wired up.
      account_number_encrypted: `MASKED-${last4}`,
      verification_status: employerBanking?.verification_status || "pending",
      funding_ready: employerBankForm.fundingReady,
    };

    const { data, error } = await supabase
      .from("banking_details")
      .upsert(payload, { onConflict: "user_id,role" })
      .select("id, bank_name, account_holder_name, account_number_last4, verification_status, funding_ready, verified_at")
      .single();

    setBankingLoading(false);
    if (error) {
      setBankingMessage(`Unable to save employer banking details: ${error.message}`);
      return;
    }
    setEmployerBanking(data);
    setBankingMessage("Employer banking details saved.");
  };

  const verifyEmployerBankingDetails = async () => {
    if (!employerBanking?.id) {
      setBankingMessage("Save banking details before verification.");
      return;
    }

    setBankingLoading(true);
    setBankingMessage("");
    const { data, error } = await supabase
      .from("banking_details")
      .update({
        verification_status: "verified",
        verification_provider: "secure_sign_sim",
        verification_reference: `SEC-${Date.now()}`,
        verified_at: new Date().toISOString(),
        funding_ready: employerBankForm.fundingReady,
      })
      .eq("id", employerBanking.id)
      .select("id, bank_name, account_holder_name, account_number_last4, verification_status, funding_ready, verified_at")
      .single();

    setBankingLoading(false);
    if (error) {
      setBankingMessage(`Employer verification failed: ${error.message}`);
      return;
    }
    setEmployerBanking(data);
    setBankingMessage("Employer bank verified via SecureSign.");
  };

  const navItems = [
    { id: "dashboard", label: t("employerNav.dashboard") },
    { id: "shifts", label: t("employerNav.shifts") },
    { id: "postshift", label: t("employerNav.postShift") },
    { id: "chat", label: t("employerNav.chat") },
    { id: "billing", label: t("employerNav.billing") },
    { id: "account", label: t("employerNav.account") },
  ];

  const handleApplicantAction = async (id, action) => {
    if (!['shortlisted', 'accepted', 'rejected'].includes(action)) return;
    const { error } = await supabase
      .from('applications')
      .update({ status: action, updated_at: new Date().toISOString(), ...(action === 'accepted' ? { employer_signed_at: new Date().toISOString() } : {}) })
      .eq('id', id);
    if (error) { toast(t('toast.updateFailed') + error.message, 'error'); return; }
    setLiveApplicants(prev => prev ? prev.map(a => a.id === id ? { ...a, status: action } : a) : prev);
    setApplicantAction(prev => ({ ...prev, [id]: action }));
    if (action === 'accepted') {
      const app = liveApplicants?.find(a => a.id === id);
      setContractModal({
        applicationId: id,
        workerName: app?.name ?? 'Worker',
        shiftTitle: selectedShift?.title ?? 'Shift',
        shiftDate: selectedShift?.date ?? '',
        shiftTime: selectedShift?.time ?? '',
        wageAsk: app?.wage ?? 0,
        headcount: selectedShift?.headcount ?? 1,
        location: selectedShift?.location ?? '',
      });
    }
  };

  const committedPayoutTotal = employerPayoutItems
    .filter(item => ['queued', 'ready', 'scheduled', 'held'].includes(item.status))
    .reduce((sum, item) => sum + Number(item.amount || 0), 0);
  const paidOutPayoutTotal = employerPayoutItems
    .filter(item => item.status === 'processed_internal')
    .reduce((sum, item) => sum + Number(item.amount || 0), 0);

  return (
    <div style={{ display: "flex", flexDirection: compact ? "column" : "row", height: "100%", fontFamily: "inherit" }}>
      {/* Sidebar */}
      <div style={{ width: compact ? "100%" : 180, borderRight: compact ? "none" : `1px solid ${BRAND.border}`, borderBottom: compact ? `1px solid ${BRAND.border}` : "none", padding: "24px 0", background: BRAND.surface, flexShrink: 0, display: "flex", flexDirection: "column" }}>
        <div style={{ padding: "0 20px 24px" }}>
          <div style={{ fontWeight: 900, fontSize: 20, color: BRAND.primary }}>CariGaji</div>
          <div style={{ fontSize: 11, color: BRAND.textMuted, fontWeight: 500 }}>Employer Console</div>
        </div>
        {navItems.map(n => (
          <button key={n.id} onClick={() => { setView(n.id); setSelectedShift(null); setPostStep(1); setEditingShiftId(null); }}
            style={{
              display: "block", width: "100%", textAlign: "left", padding: "10px 20px",
              background: view === n.id ? BRAND.primaryLight : "none",
              color: view === n.id ? BRAND.primary : BRAND.textMuted,
              border: "none", cursor: "pointer", fontFamily: "inherit", fontWeight: 600, fontSize: 13,
              borderLeft: view === n.id ? `3px solid ${BRAND.primary}` : "3px solid transparent",
              transition: "all 0.1s",
            }}>{n.label}</button>
        ))}
        <div style={{ padding: "24px 20px 0", marginTop: "auto" }}>
          <div style={{ fontSize: 12, color: BRAND.textMuted, marginBottom: 6 }}>Committed to Workers</div>
          <div style={{ fontWeight: 800, fontSize: 18, color: BRAND.green }}>{toCurrency(committedPayoutTotal)}</div>
          <Btn size="xs" variant="ghost" onClick={() => toast(t('toast.escrowTopupUnavailable'), 'info')} style={{ marginTop: 8, width: "100%", justifyContent: "center" }}>Top Up (soon)</Btn>
          <Btn size="xs" variant="secondary" onClick={() => onOpenPortal?.("worker")} style={{ marginTop: 8, width: "100%", justifyContent: "center" }}>Return to Worker App</Btn>
        </div>
      </div>

      {/* Main */}
      <div style={{ flex: 1, overflowY: "auto", padding: compact ? 16 : 28, background: BRAND.grayLight }}>

        {view === "dashboard" && (
          <div>
            <div style={{ fontSize: 22, fontWeight: 800, color: BRAND.text, marginBottom: 4 }}>{t("employer.dashboardTitle")}</div>
            <div style={{ fontSize: 14, color: BRAND.textMuted, marginBottom: 24 }}>{t("employer.goodMorning")}{employerProfile?.full_name || user?.user_metadata?.full_name || "there"}</div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12, marginBottom: 24 }}>
              <Stat label={t("employer.statActiveShifts")} value={(liveEmployerShifts ?? []).filter(s => s.status === "open").length} color={BRAND.primary} />
              <Stat label={t("employer.statTotalApplicants")} value={(liveEmployerShifts ?? []).reduce((sum, s) => sum + (s.applicants || 0), 0)} color={BRAND.blue} />
              <Stat label={t("employer.statFilledSlots")} value={`${(liveEmployerShifts ?? []).reduce((sum, s) => sum + (s.filled || 0), 0)}/${(liveEmployerShifts ?? []).reduce((sum, s) => sum + (s.headcount || 0), 0)}`} color={BRAND.green} />
              <Stat label={t("employer.statReliability")} value={employerProfile?.reliability_score ?? 0} sub="/100" color={BRAND.accent} />
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 16 }}>
              <div>
                <div style={{ fontWeight: 700, fontSize: 16, color: BRAND.text, marginBottom: 12 }}>{t("employer.activeShiftsHeading")}</div>
                {(liveEmployerShifts ?? []).filter(s => s.status !== "draft").length === 0 && (
                  <EmptyState
                    icon="📋"
                    title={liveEmployerShifts === null ? "Loading shifts…" : "No active shifts"}
                    hint={liveEmployerShifts === null ? "Hang tight while we fetch your shifts." : "Post a shift to start hiring workers."}
                  />
                )}
                {(liveEmployerShifts ?? []).filter(s => s.status !== "draft").map(s => (
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
                <div style={{ fontWeight: 700, fontSize: 16, color: BRAND.text, marginBottom: 12 }}>{t("employer.quickActions")}</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  <Btn onClick={beginNewShift} style={{ justifyContent: "center" }}>{t("employer.postNewShift")}</Btn>
                  <Card style={{ padding: 14 }}>
                    <div style={{ fontSize: 12, fontWeight: 600, color: BRAND.text, marginBottom: 8 }}>{t("employer.recentActivity")}</div>
                    {recentActivity.length === 0 && (
                      <div style={{ fontSize: 12, color: BRAND.textMuted, padding: "4px 0" }}>{t("employer.noActivity")}</div>
                    )}
                    {recentActivity.map((a, i) => (
                      <div key={i} style={{ fontSize: 12, color: BRAND.textMuted, padding: "4px 0", borderBottom: i < recentActivity.length - 1 ? `1px solid ${BRAND.border}` : "none" }}>{a}</div>
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
                <div style={{ fontSize: 22, fontWeight: 800, color: BRAND.text }}>{t("employer.shiftsTitle")}</div>
                <div style={{ fontSize: 14, color: BRAND.textMuted }}>Manage all your posted shifts</div>
              </div>
              <Btn onClick={beginNewShift}>{t("employer.postShiftBtn")}</Btn>
            </div>
            {(liveEmployerShifts ?? []).length === 0 && (
              <EmptyState
                icon="📋"
                title={liveEmployerShifts === null ? "Loading shifts…" : "No shifts posted yet"}
                hint={liveEmployerShifts === null ? "Hang tight while we fetch your shifts." : "Post your first shift to start hiring workers."}
              />
            )}
            {(liveEmployerShifts ?? []).map(s => (
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
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, marginBottom: 4 }}>
              <div style={{ fontSize: 22, fontWeight: 800, color: BRAND.text }}>{selectedShift.title}</div>
              <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
                <Btn variant="secondary" onClick={() => startEditShift(selectedShift.id)} style={{ padding: "8px 14px" }}>{Icons.Edit ? Icons.Edit({ size: 14 }) : "✏️"} <span style={{ marginLeft: 6 }}>{t("employer.editShift")}</span></Btn>
                {selectedShift.status !== "cancelled" && selectedShift.status !== "completed" && (
                  <Btn
                    variant="secondary"
                    disabled={cancellingShift}
                    onClick={async () => {
                      if (!window.confirm(`Cancel "${selectedShift.title}"? All applicants will be notified.`)) return;
                      setCancellingShift(true);
                      const { error } = await supabase.from('shifts').update({ status: 'cancelled' }).eq('id', selectedShift.id);
                      setCancellingShift(false);
                      if (error) { toast('Failed to cancel shift: ' + error.message, 'error'); return; }
                      toast('Shift cancelled. Applicants have been notified.', 'success');
                      setLiveEmployerShifts(prev => (prev ?? []).map(s => s.id === selectedShift.id ? { ...s, status: 'cancelled' } : s));
                      setSelectedShift(prev => prev ? { ...prev, status: 'cancelled' } : prev);
                    }}
                    style={{ padding: "8px 14px", color: BRAND.red }}
                  >
                    {cancellingShift ? t("employer.cancellingShift") : t("employer.cancelShift")}
                  </Btn>
                )}
              </div>
            </div>
            <div style={{ display: "flex", gap: 8, marginBottom: 20 }}>
              <Pill label={selectedShift.status} color={selectedShift.status === "open" ? "blue" : selectedShift.status === "completed" ? "green" : selectedShift.status === "cancelled" ? "red" : "gray"} />
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
            {(liveApplicants ?? []).length === 0 && (
              <EmptyState
                icon="👥"
                title={liveApplicants === null ? "Loading applicants…" : "No applicants yet"}
                hint={liveApplicants === null ? "Hang tight while we fetch applicants." : "Applicants will appear here once workers bid on this shift."}
              />
            )}
            {(liveApplicants ?? []).length > 0 && (
            <table style={{ width: "100%", borderCollapse: "collapse", background: BRAND.surface, borderRadius: 16, overflow: "hidden", border: `1px solid ${BRAND.border}` }}>
              <thead>
                <tr style={{ background: BRAND.grayLight }}>
                  {["Worker", "KYC", "Reliability", "Rating", "Bid (RM/h)", "Status", "Action"].map(h => (
                    <th key={h} style={{ padding: "12px 14px", fontSize: 11, fontWeight: 700, color: BRAND.textMuted, textAlign: "left", borderBottom: `1px solid ${BRAND.border}` }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(liveApplicants ?? []).map(a => {
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
                            <Btn size="xs" variant="success" onClick={() => handleApplicantAction(a.id, "accepted")}>{t("common.accept")}</Btn>
                            <Btn size="xs" variant="danger" onClick={() => handleApplicantAction(a.id, "rejected")}>{t("common.reject")}</Btn>
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
            )}
          </div>
        )}

        {view === "postshift" && (
          <div style={{ maxWidth: 600 }}>
            <div style={{ fontSize: 22, fontWeight: 800, color: BRAND.text, marginBottom: 4 }}>{editingShiftId ? t("employer.editShiftTitle") : t("employer.postAShiftTitle")}</div>
            <div style={{ fontSize: 14, color: BRAND.textMuted, marginBottom: 24 }}>{editingShiftId ? t("employer.editShiftSubtitle") : t("employer.postAShiftSubtitle")}</div>
            <div style={{ display: "flex", gap: 8, marginBottom: 28 }}>
              {[1, 2, 3].map(s => (
                <div key={s} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <div style={{ width: 28, height: 28, borderRadius: "50%", background: postStep >= s ? BRAND.primary : BRAND.border, color: postStep >= s ? "#fff" : BRAND.textMuted, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, fontWeight: 700 }}>{s}</div>
                  <span style={{ fontSize: 12, color: postStep >= s ? BRAND.text : BRAND.textMuted, fontWeight: postStep === s ? 700 : 400 }}>{[t("employer.stepShiftDetails"), t("employer.stepRequirements"), t("employer.stepReview")][s - 1]}</span>
                  {s < 3 && <span style={{ color: BRAND.border, fontSize: 18 }}>→</span>}
                </div>
              ))}
            </div>

            <Card>
              {postStep === 1 && (
                <div>
                  <Input label="Shift title" placeholder="e.g. F&B Server – Corporate Dinner" value={form.title} onChange={e => setForm(f => ({ ...f, title: e.target.value }))} />
                  <div style={{ marginBottom: 16 }}>
                    <label style={{ display: "block", fontSize: 13, fontWeight: 600, color: BRAND.text, marginBottom: 6 }}>Job description</label>
                    <textarea
                      placeholder="Describe the role, responsibilities, and what a good day looks like…"
                      value={form.description}
                      onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
                      style={{ width: "100%", padding: "10px 14px", borderRadius: 10, border: `1px solid ${BRAND.border}`, fontSize: 13, fontFamily: "inherit", height: 80, resize: "none", boxSizing: "border-box" }}
                    />
                  </div>
                  <Select label="Category" value={form.category} onChange={e => setForm(f => ({ ...f, category: e.target.value }))} options={["F&B", "Retail", "Event", "Logistics", "Other"].map(v => ({ value: v, label: v }))} />
                  <LocationAutocomplete label="Location" value={form.location} onChange={val => setForm(f => ({ ...f, location: val }))} />
                  <div style={{marginTop:8, marginBottom:16}}>
                    <div style={{fontSize:12, color:'#64748b', marginBottom:4}}>Address visibility</div>
                    <div style={{display:'flex', gap:12}}>
                      <label style={{display:'flex', alignItems:'center', gap:5, fontSize:13, cursor:'pointer'}}>
                        <input type="radio" name="addrVisibility" value="public"
                          checked={form.addressVisibility !== 'accepted_only'}
                          onChange={() => setForm(f=>({...f, addressVisibility:'public'}))} />
                        Show full address on listing
                      </label>
                      <label style={{display:'flex', alignItems:'center', gap:5, fontSize:13, cursor:'pointer'}}>
                        <input type="radio" name="addrVisibility" value="accepted_only"
                          checked={form.addressVisibility === 'accepted_only'}
                          onChange={() => setForm(f=>({...f, addressVisibility:'accepted_only'}))} />
                        Reveal only to accepted workers
                      </label>
                    </div>
                  </div>
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
                  <div style={{ marginBottom: 16 }}>
                    <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", marginBottom: form.offersTransportAllowance ? 8 : 0 }}>
                      <input
                        type="checkbox"
                        checked={form.offersTransportAllowance}
                        onChange={e => setForm(f => ({ ...f, offersTransportAllowance: e.target.checked, transportAllowance: e.target.checked ? f.transportAllowance : "" }))}
                      />
                      <span style={{ fontSize: 13, fontWeight: 600, color: BRAND.text }}>Offer a transport allowance</span>
                    </label>
                    {form.offersTransportAllowance && (
                      <Input
                        placeholder="e.g. 10"
                        type="number"
                        value={form.transportAllowance}
                        onChange={e => setForm(f => ({ ...f, transportAllowance: e.target.value }))}
                        style={{ marginTop: 0, marginBottom: 0 }}
                      />
                    )}
                    <div style={{ fontSize: 11, color: BRAND.textMuted, marginTop: 6 }}>
                      Optional flat amount (RM) paid on top of hourly wage to help cover workers' travel costs.
                    </div>
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
                    ["Transport allowance", form.offersTransportAllowance && form.transportAllowance ? `RM${form.transportAllowance}` : "Not offered"],
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
                    <Btn onClick={async () => {
                      if (!user) { toast(t('toast.signInToPostShift'), 'error'); return; }
                      if (!form.title || !form.date || !form.timeStart || !form.timeEnd) {
                        toast(t('toast.shiftFieldsRequired'), 'error'); return;
                      }
                      const startAt = new Date(`${form.date}T${form.timeStart}:00+08:00`).toISOString();
                      const endAt   = new Date(`${form.date}T${form.timeEnd}:00+08:00`).toISOString();
                      const wageMin = parseFloat(form.wageMin) || 0;
                      const wageMax = parseFloat(form.wageMax) || 0;
                      if (wageMax < wageMin) { toast(t('toast.maxPayGteMinPay'), 'error'); return; }
                      const payload = {
                        title:       form.title.trim(),
                        description: form.description ? form.description.trim() : null,
                        category:    form.category || 'Other',
                        location:    (form.location || '').trim() || 'Kuala Lumpur',
                        dress_code:  form.dress ? form.dress.trim() : null,
                        start_at:    startAt,
                        end_at:      endAt,
                        wage_min:    wageMin,
                        wage_max:    wageMax || wageMin,
                        headcount:   parseInt(form.headcount) || 1,
                        address_visibility: form.addressVisibility || 'public',
                        transport_allowance: form.offersTransportAllowance ? (parseFloat(form.transportAllowance) || 0) : 0,
                      };
                      let error;
                      if (editingShiftId) {
                        ({ error } = await supabase.from('shifts').update(payload).eq('id', editingShiftId));
                      } else {
                        ({ error } = await supabase.from('shifts').insert({ employer_id: user.id, status: 'open', ...payload }));
                      }
                      if (error) { toast((editingShiftId ? 'Failed to update shift: ' : t('toast.postShiftFailed')) + error.message, 'error'); return; }
                      toast(editingShiftId ? 'Shift updated!' : t('toast.shiftPublished'), 'success');
                      setEditingShiftId(null);
                      setView('shifts');
                      setPostStep(1);
                    }} style={{ flex: 1, justifyContent: "center" }}>{Icons.Rocket({ size: 14 })} <span style={{ marginLeft: 8 }}>{editingShiftId ? t("employer.saveChanges") : t("employer.publishShift")}</span></Btn>
                  </div>
                </div>
              )}
            </Card>
          </div>
        )}

        {view === "billing" && (
          <div>
            <div style={{ fontSize: 22, fontWeight: 800, color: BRAND.text, marginBottom: 24 }}>{t("employer.billingTitle")}</div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 12, marginBottom: 12 }}>
              <Stat label="Committed to workers" value={toCurrency(committedPayoutTotal)} color={BRAND.amber} />
              <Stat label="Total paid out" value={toCurrency(paidOutPayoutTotal)} color={BRAND.primary} />
            </div>
            <div style={{ fontSize: 12, color: BRAND.textMuted, marginBottom: 16 }}>
              Escrow top-ups aren't available yet — this is a preview until a real payment gateway (FPX/DuitNow) is integrated.
            </div>
            <Btn onClick={() => toast(t('toast.escrowTopupUnavailable'), 'info')} style={{ marginBottom: 24 }}>+ Top Up Escrow (soon)</Btn>
            <div style={{ fontWeight: 700, fontSize: 16, color: BRAND.text, marginBottom: 12 }}>Payout Ledger</div>
            <Card style={{ padding: 0, overflow: "hidden" }}>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr style={{ background: BRAND.grayLight }}>
                    {["Date", "Status", "Amount"].map(h => (
                      <th key={h} style={{ padding: "12px 16px", fontSize: 11, fontWeight: 700, color: BRAND.textMuted, textAlign: "left", borderBottom: `1px solid ${BRAND.border}` }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {employerPayoutItems.length === 0 && (
                    <tr><td colSpan={3} style={{ padding: "16px", fontSize: 13, color: BRAND.textMuted, textAlign: "center" }}>No payout obligations yet for this employer account.</td></tr>
                  )}
                  {employerPayoutItems.map(item => (
                    <tr key={item.id} style={{ borderBottom: `1px solid ${BRAND.border}` }}>
                      <td style={{ padding: "12px 16px", fontSize: 13, color: BRAND.textMuted }}>{item.scheduled_date ? new Date(item.scheduled_date).toLocaleDateString('en-MY') : 'TBA'}</td>
                      <td style={{ padding: "12px 16px" }}><Pill label={String(item.status || 'queued').replaceAll('_', ' ')} color={mapPayoutPillColor(item.status)} /></td>
                      <td style={{ padding: "12px 16px", fontSize: 13, fontWeight: 700, color: BRAND.text }}>{toCurrency(item.amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          </div>
        )}

        {view === "account" && (
          <div style={{ maxWidth: 500 }}>
            <div style={{ fontSize: 22, fontWeight: 800, color: BRAND.text, marginBottom: 24 }}>{t("employer.accountTitle")}</div>
            <Card style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: BRAND.text, marginBottom: 12 }}>Company Details</div>
              <Input label="Company name" placeholder="e.g. Grand Hyatt Kuala Lumpur" value={employerProfile?.full_name || user?.user_metadata?.full_name || ""} onChange={() => {}} />
              <Input label="SSM registration number" placeholder="e.g. 1234567-A" value="" onChange={() => {}} />
              <Input label="Contact email" placeholder="hr@company.com" value={user?.email || ""} onChange={() => {}} />
            </Card>
            <Card style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: BRAND.text, marginBottom: 8 }}>Employer Banking (Salary Funding)</div>
              <div style={{ fontSize: 12, color: BRAND.textMuted, marginBottom: 12 }}>
                Funding account must be verified through SecureSign before payouts can move to ready state.
              </div>
              <Select
                label="Bank"
                value={employerBankForm.bankName}
                onChange={(e) => setEmployerBankForm((prev) => ({ ...prev, bankName: e.target.value }))}
                options={MALAYSIAN_BANK_OPTIONS.map((name) => ({ value: name, label: name }))}
              />
              <Input
                label="Account holder name"
                placeholder="Company account holder"
                value={employerBankForm.accountHolderName}
                onChange={(e) => setEmployerBankForm((prev) => ({ ...prev, accountHolderName: e.target.value }))}
              />
              <Input
                label="Account number"
                placeholder="Employer funding account"
                value={employerBankForm.accountNumber}
                onChange={(e) => setEmployerBankForm((prev) => ({ ...prev, accountNumber: e.target.value }))}
              />
              <label style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12, fontSize: 13, color: BRAND.text }}>
                <input
                  type="checkbox"
                  checked={employerBankForm.fundingReady}
                  onChange={(e) => setEmployerBankForm((prev) => ({ ...prev, fundingReady: e.target.checked }))}
                />
                Funding account has sufficient balance for this cycle
              </label>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                <span style={{ fontSize: 12, color: BRAND.textMuted }}>Verification</span>
                <Pill
                  label={employerBanking?.verification_status ? `SecureSign ${employerBanking.verification_status}` : "SecureSign pending"}
                  color={mapVerificationPillColor(employerBanking?.verification_status)}
                />
              </div>
              {employerBanking?.account_number_last4 && (
                <div style={{ fontSize: 12, color: BRAND.textMuted, marginBottom: 10 }}>
                  Saved account: •••• {employerBanking.account_number_last4}
                </div>
              )}
              {bankingMessage && <div style={{ fontSize: 12, color: BRAND.textMuted, marginBottom: 10 }}>{bankingMessage}</div>}
              <div style={{ display: "flex", gap: 8 }}>
                <Btn variant="secondary" onClick={saveEmployerBankingDetails} disabled={bankingLoading} style={{ flex: 1, justifyContent: "center" }}>Save banking</Btn>
                <Btn onClick={verifyEmployerBankingDetails} disabled={bankingLoading} style={{ flex: 1, justifyContent: "center" }}>Verify via SecureSign (Demo)</Btn>
              </div>
            </Card>
            <Card style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: BRAND.text, marginBottom: 8 }}>Outgoing Salary Obligations</div>
              {employerPayoutItems.length === 0 && (
                <div style={{ fontSize: 12, color: BRAND.textMuted }}>No payout obligations yet for this employer account.</div>
              )}
              {employerPayoutItems.map((item) => (
                <div key={item.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 0", borderBottom: `1px solid ${BRAND.border}` }}>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 600, color: BRAND.text }}>{toCurrency(item.amount)}</div>
                    <div style={{ fontSize: 11, color: BRAND.textMuted }}>{item.scheduled_date ? new Date(item.scheduled_date).toLocaleDateString("en-MY") : "TBA"}</div>
                  </div>
                  <Pill label={String(item.status || "queued").replaceAll("_", " ")} color={mapPayoutPillColor(item.status)} />
                </div>
              ))}
            </Card>
            <Btn style={{ width: "100%", justifyContent: "center" }}>Save Changes</Btn>
          </div>
        )}

        {view === 'chat' && (
          <div>
            <div style={{ fontSize: 22, fontWeight: 800, color: BRAND.text, marginBottom: 4 }}>{t("chat.title")}</div>
            <div style={{ fontSize: 14, color: BRAND.textMuted, marginBottom: 16 }}>{t("chat.employerSubtitle")}</div>
            {!activeChatShift ? (
              chatConversations.length === 0 ? (
                <div style={{textAlign:'center', color:'#94a3b8', marginTop:48}}>
                  <div style={{fontSize:40}}>💬</div>
                  <div style={{marginTop:8}}>{t("chat.emptyTitleEmployer")}</div>
                  <div style={{fontSize:12, marginTop:4}}>{t("chat.emptyHintEmployer")}</div>
                </div>
              ) : (
                chatConversations.map(conv => (
                  <div key={conv.shiftId + conv.workerId} onClick={() => setActiveChatShift(conv)}
                    style={{padding:14, background:'#fff', borderRadius:10, border:'1px solid #e2e8f0',
                      marginBottom:10, cursor:'pointer', display:'flex', justifyContent:'space-between', alignItems:'center'}}>
                    <div>
                      <div style={{fontWeight:600, color:'#1e293b'}}>{conv.title}</div>
                      <div style={{fontSize:12, color:'#64748b'}}>{conv.date} · {conv.otherUserLabel}</div>
                    </div>
                    <span style={{color:'#94a3b8'}}>›</span>
                  </div>
                ))
              )
            ) : (
              <div style={{display:'flex', flexDirection:'column', height:'calc(100vh - 260px)'}}>
                <div style={{display:'flex', alignItems:'center', gap:8, marginBottom:12}}>
                  <button onClick={() => { setActiveChatShift(null); setChatMessages([]); }}
                    style={{background:'none', border:'none', cursor:'pointer', fontSize:18, color:'#2563EB'}}>←</button>
                  <div>
                    <div style={{fontWeight:600, color:'#1e293b'}}>{activeChatShift.title}</div>
                    <div style={{fontSize:12, color:'#64748b'}}>{activeChatShift.otherUserLabel}</div>
                  </div>
                </div>
                <div style={{flex:1, overflowY:'auto', display:'flex', flexDirection:'column', gap:8, paddingBottom:8}}>
                  {chatLoading && <div style={{textAlign:'center', color:'#94a3b8', padding:16}}>{t("chat.loading")}</div>}
                  {chatMessages.map(msg => {
                    const isMe = msg.sender_id === user?.id;
                    return (
                      <div key={msg.id} style={{display:'flex', justifyContent: isMe ? 'flex-end' : 'flex-start'}}>
                        <div style={{maxWidth:'75%', padding:'8px 12px', borderRadius: isMe ? '12px 12px 2px 12px' : '12px 12px 12px 2px',
                          background: isMe ? '#2563EB' : '#f1f5f9', color: isMe ? '#fff' : '#1e293b', fontSize:14}}>
                          <div>{msg.content}</div>
                          <div style={{fontSize:10, opacity:0.6, marginTop:2, textAlign:'right'}}>
                            {new Date(msg.created_at).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
                <div style={{display:'flex', gap:8, paddingTop:8, borderTop:'1px solid #e2e8f0'}}>
                  <input
                    value={chatInput} onChange={e => setChatInput(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && !e.shiftKey && sendMessage()}
                    placeholder={t("chat.inputPlaceholder")}
                    style={{flex:1, padding:'10px 12px', borderRadius:8, border:'1px solid #e2e8f0', fontSize:14}}
                  />
                  <button onClick={sendMessage}
                    style={{padding:'10px 16px', borderRadius:8, background:'#2563EB', color:'#fff', border:'none', cursor:'pointer', fontWeight:600}}>
                    {t("chat.send")}
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {contractModal && (
        <div style={{position:'fixed', inset:0, background:'rgba(0,0,0,0.5)', zIndex:1000, display:'flex', alignItems:'center', justifyContent:'center', padding:16}}>
          <div style={{background:'#fff', borderRadius:16, padding:24, maxWidth:480, width:'100%', maxHeight:'80vh', overflowY:'auto'}}>
            <h3 style={{fontSize:18, fontWeight:700, color:'#1e293b', marginBottom:4}}>📄 Employment Contract</h3>
            <p style={{fontSize:12, color:'#64748b', marginBottom:16}}>Auto-generated upon bid acceptance. Both parties must sign.</p>
            <div style={{background:'#f8fafc', borderRadius:8, padding:16, fontSize:13, lineHeight:1.8, color:'#374151', marginBottom:16}}>
              <p><strong>CariGaji Platform — Shift Work Agreement</strong></p>
              <p>This agreement is entered into between:</p>
              <p>• <strong>Employer:</strong> (your business name on file)</p>
              <p>• <strong>Worker:</strong> {contractModal.workerName}</p>
              <br/>
              <p><strong>Shift Details:</strong></p>
              <p>• Role: {contractModal.shiftTitle}</p>
              <p>• Date: {contractModal.shiftDate}</p>
              <p>• Time: {contractModal.shiftTime}</p>
              <p>• Location: {contractModal.location}</p>
              <p>• Agreed wage: RM {contractModal.wageAsk}/hr</p>
              <br/>
              <p><strong>Terms:</strong></p>
              <p>1. This is a short-term casual engagement and does not constitute permanent employment.</p>
              <p>2. The employer will pay the agreed wage rate for all hours worked, no less than the Malaysian minimum wage of RM8.72/hr.</p>
              <p>3. The employer is responsible for EPF, SOCSO, and EIS contributions as required by Malaysian law.</p>
              <p>4. The worker agrees to attend the shift punctually and perform the duties as described.</p>
              <p>5. Either party may cancel with reasonable notice. Last-minute cancellation may result in platform penalties.</p>
              <p>6. CariGaji acts as a marketplace intermediary and is not the employer in this arrangement.</p>
              <p>7. This agreement is governed by Malaysian law including the Employment Act 1955 and Gig Workers Act 2025.</p>
            </div>
            <p style={{fontSize:12, color:'#64748b', marginBottom:12}}>
              By clicking "Confirm & Send to Worker", you agree to these terms and the contract will be sent to {contractModal.workerName} for their signature.
            </p>
            <div style={{display:'flex', gap:8}}>
              <button onClick={() => setContractModal(null)}
                style={{flex:1, padding:'10px', borderRadius:8, border:'1px solid #e2e8f0', background:'#f8fafc', cursor:'pointer', color:'#64748b'}}>
                Cancel
              </button>
              <button onClick={() => {
                toast(t('toast.contractSent'), 'success');
                setContractModal(null);
              }}
                style={{flex:2, padding:'10px', borderRadius:8, background:'#2563EB', color:'#fff', border:'none', cursor:'pointer', fontWeight:600}}>
                Confirm & Send to Worker
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

// ─── ADMIN PORTAL ─────────────────────────────────────────────────────────────
const AdminPortal = ({ onOpenPortal, compact = false, user = null }) => {
  const toast = useToast();
  const [view, setView] = useState("overview");
  const [kycActions, setKycActions] = useState({});
  const [disputeActions, setDisputeActions] = useState({});
  const [flagActions, setFlagActions] = useState({});
  const [livePayoutQueue, setLivePayoutQueue] = useState(null);
  const [payoutRunning, setPayoutRunning] = useState(false);
  const [payoutMessage, setPayoutMessage] = useState("");
  const [kycQueue, setKycQueue] = useState(null);
  const [kycSignedUrls, setKycSignedUrls] = useState({});

  const navItems = ["Overview", "KYC Queue", "Disputes", "Flags", "Payouts", "Config"];

  const FLAGS = [
    { id: 1, user: "Wei Jian Lim", type: "GPS mismatch", riskScore: 87, shift: "Warehouse Packer – Shah Alam", time: "3 hours ago", status: "open" },
    { id: 2, user: "Unknown Device #42", type: "QR token reuse", riskScore: 95, shift: "Event Crew – Music Festival", time: "5 hours ago", status: "open" },
    { id: 3, user: "Muhammad Izzat", type: "No-show (confirmed)", riskScore: 72, shift: "F&B Server – Wedding Banquet", time: "1 day ago", status: "open" },
  ];

  const loadPayoutQueue = async () => {
    const { data, error } = await supabase
      .from("payout_item")
      .select("id, worker_id, employer_id, amount, scheduled_date, status, source_refs, created_at")
      .order("created_at", { ascending: false })
      .limit(30);
    if (error) {
      setLivePayoutQueue(null);
      setPayoutMessage(`Unable to load payout queue: ${error.message}`);
      return;
    }
    setLivePayoutQueue(data || []);
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

  const updatePayoutStatus = async (item, nextStatus) => {
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
      notes: "Admin action from payout queue",
      metadata_json: { source: "admin_portal" },
    });

    setPayoutMessage(`Payout ${item.id} moved to ${nextStatus}.`);
    await loadPayoutQueue();
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
    if (listError) { addToast("Could not load documents.", "error"); return; }
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

  const approveKyc = async (userId, level = "Standard") => {
    const { error } = await supabase.from("profiles").update({ kyc_level: level }).eq("id", userId);
    if (error) { addToast(`Failed to approve KYC: ${error.message}`, "error"); return; }
    setKycQueue(prev => prev.filter(u => u.id !== userId));
    setKycSignedUrls(prev => { const next = { ...prev }; delete next[userId]; return next; });
    addToast(`KYC approved — level set to ${level}`, "success");
  };

  const rejectKyc = async (userId) => {
    const { error } = await supabase.from("profiles").update({ kyc_level: "Basic" }).eq("id", userId);
    if (error) { addToast(`Failed to reject KYC: ${error.message}`, "error"); return; }
    setKycQueue(prev => prev.filter(u => u.id !== userId));
    setKycSignedUrls(prev => { const next = { ...prev }; delete next[userId]; return next; });
    addToast("KYC rejected — user reset to Basic", "info");
  };

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
              <Stat label="Pending KYC" value={kycQueue?.length ?? "—"} color={BRAND.amber} />
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
                {kycQueue === null && <div style={{ fontSize: 13, color: BRAND.textMuted }}>Loading…</div>}
                {kycQueue?.length === 0 && <div style={{ fontSize: 13, color: BRAND.textMuted }}>No pending submissions.</div>}
                {kycQueue?.slice(0, 3).map(k => (
                  <div key={k.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 0", borderBottom: `1px solid ${BRAND.border}` }}>
                    <div style={{ fontSize: 13, color: BRAND.text }}>{k.full_name || "Unnamed user"}</div>
                    <Badge color="amber" size="xs">pending</Badge>
                  </div>
                ))}
                <Btn size="xs" variant="secondary" onClick={() => setView("kycqueue")} style={{ marginTop: 10 }}>View all →</Btn>
              </Card>
              <Card>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
                  <div style={{ fontWeight: 700, fontSize: 14, color: BRAND.text }}>Active Disputes</div>
                  <Badge color="amber" size="xs">Demo data</Badge>
                </div>
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
            <div style={{ fontSize: 14, color: BRAND.textMuted, marginBottom: 24 }}>
              {kycQueue === null ? "Loading…" : `${kycQueue.length} pending review${kycQueue.length !== 1 ? "s" : ""}`}
            </div>

            {kycQueue === null && (
              <div style={{ color: BRAND.textMuted, padding: 16 }}>Loading...</div>
            )}
            {kycQueue?.length === 0 && (
              <div style={{ color: BRAND.textMuted, padding: 16 }}>✅ No pending KYC submissions.</div>
            )}

            {kycQueue?.map(worker => (
              <Card key={worker.id} style={{ marginBottom: 14 }}>
                {/* Header row */}
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 10 }}>
                  <div>
                    <div style={{ fontWeight: 700, fontSize: 15, color: BRAND.text }}>{worker.full_name || "Unnamed user"}</div>
                    <div style={{ fontSize: 12, color: BRAND.textMuted }}>{worker.id}</div>
                    <div style={{ fontSize: 12, color: BRAND.textMuted, marginTop: 2 }}>
                      Submitted: {new Date(worker.created_at).toLocaleDateString("en-MY")}
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "flex-end" }}>
                    <Btn size="sm" variant="secondary" onClick={() => loadKycDocuments(worker.id)}>
                      View Docs
                    </Btn>
                    <Btn size="sm" variant="success" onClick={() => approveKyc(worker.id, "Standard")}>
                      Approve Standard
                    </Btn>
                    <Btn size="sm" variant="success" onClick={() => approveKyc(worker.id, "Advanced")}>
                      Approve Advanced
                    </Btn>
                    <Btn size="sm" variant="danger" onClick={() => rejectKyc(worker.id)}>
                      Reject
                    </Btn>
                  </div>
                </div>

                {/* Documents */}
                {kycSignedUrls[worker.id] && (
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
                    {Object.keys(kycSignedUrls[worker.id]).length === 0 ? (
                      <div style={{ fontSize: 12, color: BRAND.textMuted }}>No documents found in storage.</div>
                    ) : (
                      Object.entries(kycSignedUrls[worker.id]).map(([filename, url]) => (
                        <a key={filename} href={url} target="_blank" rel="noopener noreferrer"
                          style={{ fontSize: 12, color: BRAND.primary, textDecoration: "underline" }}>
                          📄 {filename}
                        </a>
                      ))
                    )}
                  </div>
                )}
              </Card>
            ))}
          </div>
        )}

        {view === "disputes" && (
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
              <div style={{ fontSize: 22, fontWeight: 800, color: BRAND.text }}>Disputes Dashboard</div>
              <Badge color="amber" size="xs">Demo data</Badge>
            </div>
            <div style={{ fontSize: 14, color: BRAND.textMuted, marginBottom: 24 }}>{ADMIN_DISPUTES.length} disputes total — dispute resolution isn't wired to real data yet.</div>
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
                    <button onClick={() => toast(`Opening evidence for ${d.id}: check-in/out logs, chat history and GPS data`, "info", 6000)} style={{ fontSize: 12, color: BRAND.blue, background: "none", border: "none", cursor: "pointer", fontFamily: "inherit", textDecoration: "underline" }}>View evidence →</button>
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
              <Stat label="Pending payouts" value={toCurrency((livePayoutQueue || []).filter(p => p.status === "ready" || p.status === "scheduled").reduce((sum, item) => sum + Number(item.amount || 0), 0))} color={BRAND.amber} />
              <Stat label="Disputed (held)" value={toCurrency((livePayoutQueue || []).filter(p => p.status === "held").reduce((sum, item) => sum + Number(item.amount || 0), 0))} color={BRAND.red} />
              <Stat label="Processed internal" value={toCurrency((livePayoutQueue || []).filter(p => p.status === "processed_internal").reduce((sum, item) => sum + Number(item.amount || 0), 0))} color={BRAND.green} />
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 10, marginBottom: 12 }}>
              <Btn onClick={runScheduler} disabled={payoutRunning}>{payoutRunning ? "Running..." : "Run Internal Scheduler"}</Btn>
              <Btn variant="secondary" onClick={loadPayoutQueue}>Refresh Queue</Btn>
            </div>
            {payoutMessage && <div style={{ fontSize: 12, color: BRAND.textMuted, marginBottom: 10 }}>{payoutMessage}</div>}
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
                  {livePayoutQueue === null && (
                    <tr>
                      <td colSpan={6} style={{ padding: "20px 12px", textAlign: "center", fontSize: 13, color: BRAND.textMuted }}>Loading payout queue…</td>
                    </tr>
                  )}
                  {livePayoutQueue && livePayoutQueue.length === 0 && (
                    <tr>
                      <td colSpan={6} style={{ padding: "20px 12px", textAlign: "center", fontSize: 13, color: BRAND.textMuted }}>No payouts in the queue. Run the internal scheduler to generate this cycle's payouts.</td>
                    </tr>
                  )}
                  {(livePayoutQueue || []).map((p) => (
                    <tr key={p.id} style={{ borderBottom: `1px solid ${BRAND.border}` }}>
                      <td style={{ padding: "10px 12px", fontSize: 13, fontWeight: 600, color: BRAND.text }}>{p.worker_id || "N/A"}</td>
                      <td style={{ padding: "10px 12px", fontSize: 13, color: BRAND.textMuted }}>{p.source_refs?.shift_id ? `Shift #${p.source_refs.shift_id}` : "Shift"}</td>
                      <td style={{ padding: "10px 12px", fontSize: 13, fontWeight: 700, color: BRAND.green }}>{toCurrency(p.amount)}</td>
                      <td style={{ padding: "10px 12px", fontSize: 13, color: BRAND.textMuted }}>{p.scheduled_date ? new Date(p.scheduled_date).toLocaleDateString("en-MY") : "TBA"}</td>
                      <td style={{ padding: "10px 12px" }}><Pill label={String(p.status || "queued").replaceAll("_", " ")} color={mapPayoutPillColor(p.status)} /></td>
                      <td style={{ padding: "10px 12px" }}>
                        <div style={{ display: "flex", gap: 6 }}>
                          <Btn size="xs" variant="success" onClick={() => updatePayoutStatus(p, "processed_internal")}>Release</Btn>
                          <Btn size="xs" variant="secondary" onClick={() => updatePayoutStatus(p, "held")}>Hold</Btn>
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
              <div style={{ fontWeight: 700, fontSize: 14, color: BRAND.text, marginBottom: 14 }}>Transport allowance bands (RM)</div>
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
            <Btn onClick={() => toast("Configuration saved and applied globally", "success")} style={{ width: "100%", justifyContent: "center" }}>Save Configuration</Btn>
          </div>
        )}
      </div>
    </div>
  );
};

// Small header-level component so it can read the language context — the
// root CariGaji component below is the one that *creates* LanguageProvider,
// so it can't consume its own provider's value; this child can.
const HeaderSignInButton = ({ onClick }) => {
  const { t } = useLanguage();
  return <Btn size="sm" variant="primary" onClick={onClick}>{t("common.signIn")}</Btn>;
};

// ─── ROOT APP ─────────────────────────────────────────────────────────────────
export default function CariGaji() {
  const [portal, setPortal] = useState("worker");
  const [userRole, setUserRole] = useState(null);
  const [homeSignal, setHomeSignal] = useState(0);
  const [themePreference, setThemePreference] = useState(() => readThemePreference());
  const [systemTheme, setSystemTheme] = useState(() => getSystemTheme());
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
    accountRole: "worker",
    identityType: "MyKad",
    idNumber: "",
    dateOfBirth: "",
    kycLevel: "Basic",
    address: "",
    kycFront: null,
    kycBack: null,
    selfie: null,
    supportingDoc: null,
    agreedToTnC: false,
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

  const handleOAuth = async (provider) => {
    setAuthMessage("");
    const { error } = await supabase.auth.signInWithOAuth({
      provider, // 'google' | 'apple' | 'facebook'
      options: { redirectTo: authRedirectUrl },
    });
    // On success the browser is redirected to the provider; only errors return here.
    if (error) setAuthMessage(`${provider} sign-in unavailable: ${error.message}`);
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
    const fullPhone = `${COUNTRIES.find(c => c.code === authForm.countryCode)?.dialCode || "+60"}${authForm.phone}`;
    // Keep only non-sensitive fields in auth metadata (it is client-readable
    // and self-editable). Sensitive PII goes to the owner-only user_private table.
    const { data, error } = await supabase.auth.signUp({
      email: authForm.email,
      password: authForm.password,
      options: {
        emailRedirectTo: authRedirectUrl,
        data: {
          full_name: authForm.fullName,
          kyc_level: autoKycLevel,
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
        // Public-safe profile (employers may read) + private PII (owner only).
        await supabase.from("profiles").upsert(
          { id: registeredUserId, full_name: authForm.fullName, kyc_level: autoKycLevel, role: authForm.accountRole === "employer" ? "employer" : "worker" },
          { onConflict: "id" }
        );
        await supabase.from("user_private").upsert(
          {
            id: registeredUserId,
            identity_type: authForm.identityType,
            id_number: authForm.idNumber,
            date_of_birth: authForm.dateOfBirth || null,
            address: authForm.address,
            phone: fullPhone,
          },
          { onConflict: "id" }
        );

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

  const refreshUser = async () => {
    const { data } = await supabase.auth.getUser();
    setUser(data?.user ?? null);
  };

  // Fetch the account's stored role and default the portal accordingly on
  // sign-in: employer accounts land in the Employer Console, admins in the
  // Admin Dashboard, everyone else in the Worker app. Console access below
  // (Settings buttons) is gated on this same role.
  useEffect(() => {
    if (!user) { setUserRole(null); return; }
    let active = true;
    supabase.from('profiles').select('role').eq('id', user.id).maybeSingle()
      .then(({ data }) => {
        if (!active) return;
        const role = data?.role ?? 'worker';
        setUserRole(role);
        const isAdminAccount = user?.app_metadata?.role === 'admin';
        if (isAdminAccount) setPortal('admin');
        else if (role === 'employer') setPortal('employer');
        else setPortal('worker');
      });
    return () => { active = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

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
  const isAdmin = user?.app_metadata?.role === "admin";
  const resolvedTheme = resolveThemeMode(themePreference, systemTheme);
  const themeVars = buildThemeVars(resolvedTheme);

  useEffect(() => {
    writeThemePreference(themePreference);
  }, [themePreference]);

  useEffect(() => {
    applyThemeToDocument(resolvedTheme);
  }, [resolvedTheme]);

  useEffect(() => {
    if (!window.matchMedia) return undefined;
    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const handleChange = (event) => {
      setSystemTheme(event.matches ? "dark" : "light");
    };

    handleChange(mediaQuery);
    if (mediaQuery.addEventListener) {
      mediaQuery.addEventListener("change", handleChange);
      return () => mediaQuery.removeEventListener("change", handleChange);
    }

    mediaQuery.addListener(handleChange);
    return () => mediaQuery.removeListener(handleChange);
  }, []);

  return (
    <LanguageProvider>
    <ToastProvider>
    <div style={{
      // Use dynamic viewport height so the shell exactly fills the visible
      // area on mobile. Mixing minHeight:100vh here made the container taller
      // than the screen (100vh counts space behind the browser/system bars),
      // pushing the sticky bottom nav below the fold.
      height: "100dvh",
      minHeight: "100dvh",
      width: "100%",
      ...themeVars,
      background: isMobile
        ? `linear-gradient(180deg, ${BRAND.primary}08 0%, ${BRAND.page} 18%, ${BRAND.page} 100%)`
        : `radial-gradient(circle at top, ${BRAND.primary}20 0%, ${resolvedTheme === "dark" ? "#09111d" : "#f8fafc"} 42%, ${resolvedTheme === "dark" ? BRAND.dark : BRAND.page} 100%)`,
      display: "flex",
      alignItems: "stretch",
      justifyContent: "stretch",
      padding: 0,
      fontFamily: "'DM Sans', system-ui, sans-serif",
    }}>
      <div style={{
        width: "100%",
        height: "100%",
        minHeight: "100dvh",
        background: isMobile ? BRAND.surface : BRAND.panel,
        borderRadius: 0,
        overflow: "hidden",
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
          background: BRAND.panel,
          backdropFilter: "blur(16px)",
          flexShrink: 0,
        }}>
          <button
            onClick={() => { setPortal("worker"); setHomeSignal(s => s + 1); }}
            aria-label="CariGaji home — go to Discover"
            style={{ border: "none", background: "transparent", padding: 0, cursor: "pointer", textAlign: "left", fontFamily: "inherit" }}
          >
            <div style={{ fontSize: isMobile ? 18 : 22, fontWeight: 900, color: BRAND.text, letterSpacing: "-0.03em" }}>
              Cari<span style={{ color: BRAND.primary }}>Gaji</span>
            </div>
            <div style={{ fontSize: isMobile ? 10 : 12, color: BRAND.textMuted }}>Verified shift marketplace</div>
          </button>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            {!isMobile && (
              <Badge color={portal === "worker" ? "green" : portal === "employer" ? "blue" : "amber"}>
                {cfg.label}
              </Badge>
            )}
            <Btn
              size="sm"
              variant="secondary"
              onClick={() => setThemePreference(current => cycleThemePreference(current))}
              aria-label={`Theme: ${themePreference}. Click to change.`}
              title={`Theme: ${themePreference}`}
              style={{ width: 112, justifyContent: "center", gap: 7 }}
            >
              <span aria-hidden="true">{themePreference === "system" ? "🖥️" : themePreference === "light" ? "☀️" : "🌙"}</span>
              <span>{themePreference === "system" ? "System" : themePreference === "light" ? "Light" : "Dark"}</span>
            </Btn>
            {user && <NotificationBell user={user} />}
            {user ? (
              <ProfileMenu
                user={user}
                onSignOut={async () => { await supabase.auth.signOut(); setUser(null); }}
              />
            ) : (
              <HeaderSignInButton onClick={() => openAuthModal("signin")} />
            )}
          </div>
        </div>
        <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
          {portal === "worker" && <WorkerPortal onOpenPortal={setPortal} isMobile={isMobile} user={user} userRole={userRole} onRequireAuth={openAuthModal} onUserUpdated={refreshUser} homeSignal={homeSignal} />}
          {portal === "employer" && <EmployerPortal onOpenPortal={setPortal} compact={isMobile} user={user} onRequireAuth={openAuthModal} />}
          {portal === "admin" && (
            isAdmin
              ? <AdminPortal onOpenPortal={setPortal} compact={isMobile} user={user} onRequireAuth={openAuthModal} />
              : (
                <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 12, padding: 32, textAlign: "center" }}>
                  <div style={{ fontSize: 40 }} aria-hidden="true">🚫</div>
                  <div style={{ fontSize: 18, fontWeight: 800, color: BRAND.text }}>Admin access required</div>
                  <div style={{ fontSize: 13, color: BRAND.textMuted, maxWidth: 320 }}>
                    {user ? "Your account is not an administrator." : "Sign in with an administrator account to continue."}
                  </div>
                  <Btn variant="secondary" onClick={() => setPortal("worker")}>Back to Worker App</Btn>
                </div>
              )
          )}
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
        onOAuth={handleOAuth}
      />
    </div>
    </ToastProvider>
    </LanguageProvider>
  );
}