import http from 'node:http';
import crypto from 'node:crypto';
import { URL } from 'node:url';
import fs from 'node:fs/promises';

const DEFAULT_PROJECT_REF = 'eqxpskyymohghxgtykfr';
const workspaceRoot = process.cwd();

function base64url(buffer) {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest();
}

function genVerifier() {
  return base64url(crypto.randomBytes(48));
}

function usage() {
  console.log(`Usage: node scripts/get-mcp-token.mjs [--client-id=ID] [--redirect-uri=URI] [--project-ref=REF] [--help]\n\n` +
    'Environment: SUPABASE_OAUTH_CLIENT_ID may be used for client id.\n' +
    'The script performs an interactive PKCE flow by starting a local HTTP callback server.\n' +
    'To only print an authorize URL (no server), pass --dry-run.');
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help')) return usage();
  const opts = {};
  for (const a of args) {
    if (a.startsWith('--client-id=')) opts.clientId = a.split('=')[1];
    if (a.startsWith('--redirect-uri=')) opts.redirectUri = a.split('=')[1];
    if (a.startsWith('--project-ref=')) opts.projectRef = a.split('=')[1];
    if (a === '--dry-run') opts.dryRun = true;
  }

  const clientId = opts.clientId || process.env.SUPABASE_OAUTH_CLIENT_ID;
  const projectRef = opts.projectRef || DEFAULT_PROJECT_REF;
  const supabaseUrl = `https://${projectRef}.supabase.co`;
  const authorizeEndpoint = `${supabaseUrl}/auth/v1/oauth/authorize`;
  const tokenEndpoint = `${supabaseUrl}/auth/v1/oauth/token`;

  if (!clientId) {
    console.error('Missing client id. Provide --client-id or set SUPABASE_OAUTH_CLIENT_ID');
    process.exit(2);
  }

  const redirectUri = opts.redirectUri || 'http://localhost:5173/callback';
  const redirectUrl = new URL(redirectUri);
  const port = parseInt(redirectUrl.port || '5173', 10);

  const codeVerifier = genVerifier();
  const codeChallenge = base64url(sha256(Buffer.from(codeVerifier)));
  const state = base64url(crypto.randomBytes(12));
  const scope = encodeURIComponent('projects:read database:read');

  const authorizeUrl = `${authorizeEndpoint}?client_id=${encodeURIComponent(clientId)}&response_type=code&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${scope}&code_challenge=${encodeURIComponent(codeChallenge)}&code_challenge_method=S256&state=${encodeURIComponent(state)}`;

  console.log('\nAuthorize URL:\n');
  console.log(authorizeUrl + '\n');

  if (opts.dryRun) {
    console.log('Dry run: printed authorize URL and exiting.');
    return;
  }

  console.log(`Starting local callback server on port ${port} to receive authorization code...`);

  const server = http.createServer(async (req, res) => {
    try {
      const reqUrl = new URL(req.url, `http://localhost:${port}`);
      if (reqUrl.pathname !== redirectUrl.pathname) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }
      const code = reqUrl.searchParams.get('code');
      const receivedState = reqUrl.searchParams.get('state');
      if (!code || receivedState !== state) {
        res.writeHead(400, { 'content-type': 'text/html' });
        res.end('<h1>Invalid response</h1>');
        console.error('Invalid callback response or state mismatch');
        server.close();
        return;
      }

      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<h1>Authorization received. You can close this window.</h1>');
      server.close();

      console.log('Exchanging code for token...');
      const body = new URLSearchParams();
      body.set('grant_type', 'authorization_code');
      body.set('code', code);
      body.set('redirect_uri', redirectUri);
      body.set('client_id', clientId);
      body.set('code_verifier', codeVerifier);

      const resp = await fetch(tokenEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });
      const json = await resp.json();
      if (!resp.ok) {
        console.error('Token endpoint error', json);
        process.exit(1);
      }

      const outPath = workspaceRoot + '/.mcp_token.json';
      await fs.writeFile(outPath, JSON.stringify(json, null, 2), { mode: 0o600 });
      console.log(`Saved token response to ${outPath}`);
      console.log('Access token (truncated):', json.access_token ? json.access_token.slice(0, 40) + '...' : '(none)');
    } catch (err) {
      console.error('Error handling callback:', err);
      server.close();
    }
  });

  server.listen(port, '127.0.0.1');
  console.log('\nOpen the authorize URL in your browser and complete the login.');
}

main();
