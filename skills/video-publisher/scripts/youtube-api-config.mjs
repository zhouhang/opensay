#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { readPackage } from './lib/content-package.mjs';
import { buildIdentity } from './v2/lib/identity.mjs';
import { bindExistingYoutubeVideo, oauthPath, oauthStatus, YoutubeClient, youtubeAuthorizationUrl } from './v2/platforms/youtube-api.mjs';

const AUTHORIZATION_TIMEOUT_MS = 15 * 60 * 1000;

const [command, ...args] = process.argv.slice(2);
if (command === 'status') {
  console.log(JSON.stringify(oauthStatus(), null, 2));
} else if (command === 'authorize' && args[0] && args[1] && /^\d+$/.test(args[2] || '')) {
  const [clientFile, channelId, categoryId] = args;
  const client = JSON.parse(fs.readFileSync(clientFile, 'utf8')).installed;
  if (!client?.client_id || !client?.client_secret) throw new Error('Use a Google OAuth Desktop app client JSON');
  const nonce = randomBytes(32).toString('hex');
  const verifier = randomBytes(48).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  let redirectUri;
  let timer;
  const server = http.createServer(async (req, res) => {
    const incoming = new URL(req.url, 'http://127.0.0.1');
    const state = incoming.searchParams.get('state') || '';
    if (incoming.pathname !== '/oauth/callback' || state.length !== nonce.length
      || !timingSafeEqual(Buffer.from(state), Buffer.from(nonce))) {
      res.writeHead(400).end('Invalid OAuth callback'); return;
    }
    clearTimeout(timer);
    try {
      if (!incoming.searchParams.get('code')) throw new Error('Authorization denied');
      const tokenResponse = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', signal: AbortSignal.timeout(30000),
        body: new URLSearchParams({ client_id: client.client_id, client_secret: client.client_secret,
          grant_type: 'authorization_code', code: incoming.searchParams.get('code'), redirect_uri: redirectUri, code_verifier: verifier }) });
      if (!tokenResponse.ok) throw new Error(`Token exchange failed (${tokenResponse.status})`);
      const token = await tokenResponse.json();
      if (!token.refresh_token) throw new Error('No refresh token returned; authorize again with consent');
      const credentials = { client_id: client.client_id, client_secret: client.client_secret,
        refresh_token: token.refresh_token, channel_id: channelId, default_category_id: categoryId };
      await new YoutubeClient(credentials).authenticate();
      const destination = oauthPath();
      fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
      const temp = `${destination}.${randomBytes(8).toString('hex')}.tmp`;
      fs.writeFileSync(temp, JSON.stringify(credentials), { mode: 0o600 });
      fs.renameSync(temp, destination);
      res.end('YouTube authorization complete. You may close this page.');
      console.log(JSON.stringify({ authorized: true, channelId, path: destination }));
    } catch (error) {
      res.writeHead(400).end('YouTube authorization failed. See terminal for next steps.');
      console.error(error.message); process.exitCode = 1;
    } finally { server.close(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  redirectUri = `http://127.0.0.1:${server.address().port}/oauth/callback`;
  const authorizationUrl = youtubeAuthorizationUrl({ clientId: client.client_id, redirectUri,
    state: nonce, codeChallenge: challenge });
  console.log(`Open this Google authorization URL within 15 minutes (callback ${redirectUri}):\n${authorizationUrl}`);
  timer = setTimeout(() => { console.error('OAuth authorization timed out; run authorize again.'); process.exitCode = 1; server.close(); }, AUTHORIZATION_TIMEOUT_MS);
} else if (command === 'bind-existing' && args.length === 4) {
  const [packageFile, stateRoot, jobId, videoId] = args;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(jobId)) throw new Error('Invalid job ID');
  if (!/^[A-Za-z0-9_-]{6,32}$/.test(videoId)) throw new Error('Invalid YouTube video ID');
  const packagePath = path.resolve(packageFile);
  const jobDir = path.join(path.resolve(stateRoot), jobId);
  const jobStatePath = path.join(jobDir, 'state.json');
  if (!fs.existsSync(jobStatePath)) throw new Error(`Initialize the YouTube job with --inspect-only first: ${jobStatePath}`);
  const pkg = readPackage(packagePath);
  const identity = await buildIdentity(pkg);
  const job = JSON.parse(fs.readFileSync(jobStatePath, 'utf8'));
  if (job.fingerprint !== identity.fingerprint || path.resolve(job.packagePath) !== packagePath || !job.platforms?.youtube) {
    throw new Error('YouTube job does not belong to this exact package');
  }
  const checkpointPath = path.join(jobDir, 'checkpoints', 'youtube.receipts.json');
  const result = await bindExistingYoutubeVideo({ pkg, fingerprint: identity.fingerprint, checkpointPath, videoId });
  console.log(JSON.stringify(result, null, 2));
} else {
  console.error('Usage: node scripts/youtube-api-config.mjs status');
  console.error('   or: node scripts/youtube-api-config.mjs authorize <desktop-client.json> <channel-id> <category-id>');
  console.error('   or: node scripts/youtube-api-config.mjs bind-existing <package.json> <state-root> <job-id> <video-id>');
  process.exitCode = 2;
}
