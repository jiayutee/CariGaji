# CariGaji
A transparent, verified marketplace for short-term shifts where employers post shifts with a wage range and workers bid within guardrails.

https://jiayutee.github.io/CariGaji/

## Supabase setup

1. Install dependencies:

	```bash
	npm install
	```

2. Keep your local Supabase values in `.env.local`:

	```env
	VITE_SUPABASE_URL=https://eqxpskyymohghxgtykfr.supabase.co
	VITE_SUPABASE_ANON_KEY=your_public_anon_key
	```

3. Use `src/lib/supabase.js` for all client-side database and storage calls.

4. Keep the direct PostgreSQL connection string for backend/admin use only. Do not put the database password in the frontend.

5. Map files like KYC documents and selfies to Supabase Storage, and store only the storage paths in SQL columns such as `verifications.doc_ref` and `verifications.selfie_ref`.
