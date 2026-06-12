import { createHash, randomBytes } from 'crypto';
import cors from 'cors';
import express from 'express';
import { networkInterfaces } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import {
  addFriendship,
  clearPresence,
  createFriendRequest,
  createUser,
  declineFriendRequest,
  deleteFriendRequest,
  getFriendRequest,
  getFriendsPresence,
  getUserByFriendCode,
  getUserById,
  getUserByTokenHash,
  hasFriendship,
  listFriends,
  listIncomingRequests,
  listOutgoingRequests,
  createSocialChallenge,
  deleteSocialChallenge,
  findActiveSocialChallenge,
  getSocialChallengeForUser,
  listSocialChallengesForUser,
  removeFriendship,
  syncFriendNicknamesForUser,
  updateSocialChallengeStatus,
  updateUserProfile,
  updateUserToken,
  upsertPresence
} from './db.mjs';

const PORT = Number(process.env['PORT'] ?? 3001);
const HOST = process.env['HOST'] ?? '0.0.0.0';
const LOG_HEARTBEATS = process.env['LOG_HEARTBEATS'] === 'true';
const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const DATA_ROOT = process.env['SOCIAL_DATA_DIR']?.trim() || join(SERVER_DIR, 'data');

function normalizeIp(raw) {
  if (!raw || typeof raw !== 'string') return 'inconnu';
  return raw.replace(/^::ffff:/, '');
}

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) {
    return normalizeIp(forwarded.split(',')[0].trim());
  }

  return normalizeIp(req.socket?.remoteAddress ?? req.ip ?? 'inconnu');
}

function isLocalClient(ip) {
  return ip === '127.0.0.1' || ip === '::1' || ip === 'localhost' || ip === 'inconnu';
}

function logServerEvent(message, details) {
  if (details) {
    console.log(`[social-server] ${message}`, details);
    return;
  }
  console.log(`[social-server] ${message}`);
}

function requestLogMiddleware(req, res, next) {
  if (!LOG_HEARTBEATS && req.path === '/api/presence/heartbeat') {
    return next();
  }

  const startedAt = Date.now();
  const clientIp = getClientIp(req);
  const scope = isLocalClient(clientIp) ? 'LOCAL' : 'REMOTE';
  const origin = req.headers.origin ?? '-';
  const userAgent = String(req.headers['user-agent'] ?? '-').slice(0, 100);

  res.on('finish', () => {
    const durationMs = Date.now() - startedAt;
    const authUser = req.authUser;
    const userSuffix = authUser ? ` user=${authUser.friend_code}` : '';
    logServerEvent(
      `[${scope}] ${req.method} ${req.originalUrl} → ${res.statusCode} (${durationMs}ms) | client=${clientIp} origin=${origin}${userSuffix} | ua=${userAgent}`
    );

    if (scope === 'REMOTE' && res.statusCode >= 400) {
      logServerEvent(
        `↳ Échec depuis le réseau (${clientIp}) — vérifiez l'URL, le pare-feu Windows (TCP ${PORT}) et que le serveur écoute sur ${HOST}:${PORT}.`
      );
    }
  });

  next();
}

function getLanUrls(port = PORT) {
  const urls = [];
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      const isIpv4 = entry.family === 'IPv4' || entry.family === 4;
      if (isIpv4 && !entry.internal) {
        urls.push(`http://${entry.address}:${port}`);
      }
    }
  }
  return urls;
}
const PRESENCE_STALE_MS = 90_000;
const FRIEND_CODE_RE = /^SGD-[A-F0-9]{8}$/;

const app = express();
app.set('trust proxy', true);
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '256kb' }));
app.use(requestLogMiddleware);

function hashToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

function createApiToken() {
  return randomBytes(32).toString('hex');
}

function extractBearer(req) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return null;
  return header.slice(7).trim();
}

function authMiddleware(req, res, next) {
  const token = extractBearer(req);
  if (!token) {
    logServerEvent(
      `[AUTH] Token manquant sur ${req.method} ${req.originalUrl} | client=${getClientIp(req)}`
    );
    return res.status(401).json({ error: 'Token manquant.' });
  }

  const user = getUserByTokenHash(hashToken(token));
  if (!user) {
    logServerEvent(
      `[AUTH] Token invalide sur ${req.method} ${req.originalUrl} | client=${getClientIp(req)}`
    );
    return res.status(401).json({ error: 'Token invalide.' });
  }

  req.authUser = user;
  req.apiToken = token;
  next();
}

function validateFriendCode(friendCode) {
  return typeof friendCode === 'string' && FRIEND_CODE_RE.test(friendCode.trim().toUpperCase());
}

function normalizeFriendCode(friendCode) {
  return friendCode.trim().toUpperCase();
}

function mapPresenceRow(row) {
  if (!row) return null;
  let activeProject = null;
  if (row.active_project_json) {
    try {
      activeProject = JSON.parse(row.active_project_json);
    } catch {
      activeProject = null;
    }
  }

  return {
    userId: row.user_id,
    friendCode: row.friend_code,
    displayName: row.display_name ?? 'Joueur',
    avatarColor: row.avatar_color ?? '#607d8b',
    lastSeen: row.last_seen ?? 0,
    activeProject
  };
}

const SOCIAL_API_VERSION = 3;
const SOCIAL_CHALLENGE_DURATION_MS = 7 * 24 * 60 * 60 * 1000;

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'saas-game-dev-social', apiVersion: SOCIAL_API_VERSION });
});

app.post('/api/session/register', (req, res) => {
  const userId = String(req.body?.userId ?? '').trim();
  const friendCode = normalizeFriendCode(String(req.body?.friendCode ?? ''));
  const displayName = String(req.body?.displayName ?? 'Joueur').trim().slice(0, 24) || 'Joueur';
  const avatarColor = String(req.body?.avatarColor ?? '#1976d2').trim();

  if (!userId || !validateFriendCode(friendCode)) {
    return res.status(400).json({ error: 'Profil invalide.' });
  }

  const existing = getUserById(userId);
  const incomingToken = extractBearer(req);

  if (existing) {
    if (existing.friend_code !== friendCode) {
      return res.status(409).json({ error: 'Le code ami ne correspond pas à la session.' });
    }

    const tokenValid =
      incomingToken && hashToken(incomingToken) === existing.token_hash;

    if (tokenValid) {
      updateUserProfile(userId, displayName, avatarColor);
      return res.json({ apiToken: incomingToken, friendCode: existing.friend_code });
    }

    // Récupération : userId + code ami correspondent → nouveau jeton (client local).
    const apiToken = createApiToken();
    updateUserToken(userId, hashToken(apiToken));
    updateUserProfile(userId, displayName, avatarColor);
    return res.json({ apiToken, friendCode: existing.friend_code });
  }

  const codeOwner = getUserByFriendCode(friendCode);
  if (codeOwner && codeOwner.user_id !== userId) {
    return res.status(409).json({ error: 'Ce code ami est déjà utilisé.' });
  }

  const apiToken = createApiToken();
  createUser({
    userId,
    friendCode,
    displayName,
    avatarColor,
    tokenHash: hashToken(apiToken),
    createdAt: Date.now()
  });

  res.status(201).json({ apiToken, friendCode });
});

app.post('/api/presence/heartbeat', authMiddleware, (req, res) => {
  const activeProject = req.body?.activeProject ?? null;
  const displayName = String(req.body?.displayName ?? req.authUser.display_name).trim().slice(0, 24);
  const avatarColor = String(req.body?.avatarColor ?? req.authUser.avatar_color).trim();

  updateUserProfile(req.authUser.user_id, displayName, avatarColor);
  syncFriendNicknamesForUser(req.authUser.user_id, displayName);
  upsertPresence({
    userId: req.authUser.user_id,
    friendCode: req.authUser.friend_code,
    displayName,
    avatarColor,
    activeProjectJson: activeProject ? JSON.stringify(activeProject) : null,
    lastSeen: Date.now()
  });

  res.json({ ok: true });
});

app.post('/api/session/offline', authMiddleware, (_req, res) => {
  clearPresence(_req.authUser.user_id);
  res.json({ ok: true });
});

app.get('/api/friends', authMiddleware, (req, res) => {
  const friends = listFriends(req.authUser.user_id).map(row => ({
    friendCode: row.friend_code,
    nickname: row.nickname,
    addedAt: new Date(row.added_at).toISOString()
  }));
  res.json({ friends });
});

function linkMutualFriends(userA, userB, nicknameA, nicknameB) {
  if (!hasFriendship(userA.user_id, userB.user_id)) {
    addFriendship({
      ownerUserId: userA.user_id,
      friendUserId: userB.user_id,
      friendCode: userB.friend_code,
      nickname: nicknameA || userB.display_name,
      addedAt: Date.now()
    });
  }

  if (!hasFriendship(userB.user_id, userA.user_id)) {
    addFriendship({
      ownerUserId: userB.user_id,
      friendUserId: userA.user_id,
      friendCode: userA.friend_code,
      nickname: nicknameB || userA.display_name,
      addedAt: Date.now()
    });
  }
}

function mapRequestRow(row) {
  return {
    friendCode: row.friend_code,
    displayName: row.display_name,
    avatarColor: row.avatar_color,
    createdAt: new Date(row.created_at).toISOString()
  };
}

app.get('/api/friends/requests', authMiddleware, (req, res) => {
  res.json({
    incoming: listIncomingRequests(req.authUser.user_id).map(mapRequestRow),
    outgoing: listOutgoingRequests(req.authUser.user_id).map(mapRequestRow)
  });
});

function handleFriendInvite(req, res) {
  const friendCode = normalizeFriendCode(String(req.body?.friendCode ?? ''));

  if (!validateFriendCode(friendCode)) {
    return res.status(400).json({ error: 'Code ami invalide.' });
  }

  if (friendCode === req.authUser.friend_code) {
    return res.status(400).json({ error: 'Vous ne pouvez pas vous inviter vous-même.' });
  }

  const target = getUserByFriendCode(friendCode);
  if (!target) {
    return res.status(404).json({ error: 'Utilisateur introuvable. Il doit ouvrir l\'application au moins une fois.' });
  }

  if (hasFriendship(req.authUser.user_id, target.user_id)) {
    return res.status(409).json({ error: 'Vous êtes déjà amis.' });
  }

  const reversePending = getFriendRequest(target.user_id, req.authUser.user_id);
  if (reversePending?.status === 'pending') {
    linkMutualFriends(req.authUser, target, target.display_name, req.authUser.display_name);
    deleteFriendRequest(target.user_id, req.authUser.user_id);
    deleteFriendRequest(req.authUser.user_id, target.user_id);
    return res.json({
      accepted: true,
      message: 'Demande réciproque acceptée automatiquement.',
      friend: {
        friendCode: target.friend_code,
        nickname: target.display_name,
        addedAt: new Date().toISOString()
      }
    });
  }

  const existingOutgoing = getFriendRequest(req.authUser.user_id, target.user_id);
  if (existingOutgoing?.status === 'pending') {
    return res.status(409).json({ error: 'Invitation déjà envoyée.' });
  }

  createFriendRequest({
    fromUserId: req.authUser.user_id,
    toUserId: target.user_id,
    createdAt: Date.now()
  });

  res.status(201).json({
    request: mapRequestRow({
      friend_code: target.friend_code,
      display_name: target.display_name,
      avatar_color: target.avatar_color,
      created_at: Date.now()
    })
  });
}

app.post('/api/friends/request', authMiddleware, handleFriendInvite);

/** Compatibilité clients / serveurs v1 (ajout direct). */
app.post('/api/friends', authMiddleware, handleFriendInvite);

app.post('/api/friends/requests/:friendCode/accept', authMiddleware, (req, res) => {
  const friendCode = normalizeFriendCode(String(req.params.friendCode ?? ''));
  const target = getUserByFriendCode(friendCode);

  if (!target) {
    return res.status(404).json({ error: 'Utilisateur introuvable.' });
  }

  const request = getFriendRequest(target.user_id, req.authUser.user_id);
  if (!request || request.status !== 'pending') {
    return res.status(404).json({ error: 'Aucune demande en attente de cet utilisateur.' });
  }

  linkMutualFriends(req.authUser, target, target.display_name, req.authUser.display_name);
  deleteFriendRequest(target.user_id, req.authUser.user_id);
  deleteFriendRequest(req.authUser.user_id, target.user_id);

  res.json({
    friend: {
      friendCode: target.friend_code,
      nickname: target.display_name,
      addedAt: new Date().toISOString()
    }
  });
});

app.post('/api/friends/requests/:friendCode/decline', authMiddleware, (req, res) => {
  const friendCode = normalizeFriendCode(String(req.params.friendCode ?? ''));
  const target = getUserByFriendCode(friendCode);

  if (!target) {
    return res.status(404).json({ error: 'Utilisateur introuvable.' });
  }

  declineFriendRequest(target.user_id, req.authUser.user_id);
  res.json({ ok: true });
});

app.delete('/api/friends/:friendCode', authMiddleware, (req, res) => {
  const friendCode = normalizeFriendCode(String(req.params.friendCode ?? ''));
  if (!validateFriendCode(friendCode)) {
    return res.status(400).json({ error: 'Code ami invalide.' });
  }

  removeFriendship(req.authUser.user_id, friendCode);
  res.json({ ok: true });
});

function mapSocialChallengeRow(row, viewerUserId) {
  const isChallenger = row.from_user_id === viewerUserId;
  return {
    id: row.id,
    metric: row.metric,
    label: row.label,
    targetValue: row.target_value,
    fromValueAtStart: row.from_value_at_start,
    toValueAtStart: row.to_value_at_start,
    createdAt: new Date(row.created_at).toISOString(),
    deadline: new Date(row.deadline).toISOString(),
    status:
      row.status === 'active'
        ? 'active'
        : row.winner_user_id === viewerUserId
          ? 'won'
          : 'lost',
    winnerUserId: row.winner_user_id ?? null,
    resolvedAt: row.resolved_at ? new Date(row.resolved_at).toISOString() : null,
    direction: isChallenger ? 'outgoing' : 'incoming',
    challengerFriendCode: row.from_friend_code,
    challengerDisplayName: row.from_display_name,
    challengedFriendCode: row.to_friend_code,
    challengedDisplayName: row.to_display_name,
    friendCode: isChallenger ? row.to_friend_code : row.from_friend_code,
    friendDisplayName: isChallenger ? row.to_display_name : row.from_display_name
  };
}

app.get('/api/social-challenges', authMiddleware, (req, res) => {
  const rows = listSocialChallengesForUser(req.authUser.user_id);
  res.json({
    challenges: rows.map(row => mapSocialChallengeRow(row, req.authUser.user_id))
  });
});

app.post('/api/social-challenges', authMiddleware, (req, res) => {
  const friendCode = normalizeFriendCode(String(req.body?.friendCode ?? ''));
  const metric = String(req.body?.metric ?? '').trim();
  const label = String(req.body?.label ?? '').trim().slice(0, 64);
  const targetValue = Number(req.body?.targetValue ?? 0);
  const myValueAtStart = Number(req.body?.myValueAtStart ?? 0);
  const friendValueAtStart = Number(req.body?.friendValueAtStart ?? 0);

  if (!validateFriendCode(friendCode)) {
    return res.status(400).json({ error: 'Code ami invalide.' });
  }

  if (!metric || !label || !Number.isFinite(targetValue) || targetValue <= 0) {
    return res.status(400).json({ error: 'Défi invalide.' });
  }

  const target = getUserByFriendCode(friendCode);
  if (!target) {
    return res.status(404).json({ error: 'Ami introuvable.' });
  }

  if (!hasFriendship(req.authUser.user_id, target.user_id)) {
    return res.status(403).json({ error: 'Vous devez être amis pour lancer un défi.' });
  }

  const existing = findActiveSocialChallenge(req.authUser.user_id, target.user_id, metric);
  if (existing) {
    return res.status(409).json({ error: 'Un défi actif existe déjà sur cette métrique.' });
  }

  const now = Date.now();
  const id = randomBytes(16).toString('hex');
  createSocialChallenge({
    id,
    fromUserId: req.authUser.user_id,
    toUserId: target.user_id,
    metric,
    label,
    targetValue: Math.round(targetValue),
    fromValueAtStart: Math.round(myValueAtStart),
    toValueAtStart: Math.round(friendValueAtStart),
    createdAt: now,
    deadline: now + SOCIAL_CHALLENGE_DURATION_MS
  });

  const rows = listSocialChallengesForUser(req.authUser.user_id);
  const created = rows.find(r => r.id === id);
  res.status(201).json({
    challenge: created ? mapSocialChallengeRow(created, req.authUser.user_id) : null
  });
});

app.patch('/api/social-challenges/:id', authMiddleware, (req, res) => {
  const id = String(req.params.id ?? '').trim();
  const winnerUserId = req.body?.winnerUserId ? String(req.body.winnerUserId) : null;

  if (!winnerUserId) {
    return res.status(400).json({ error: 'Gagnant requis.' });
  }

  const challenge = getSocialChallengeForUser(id, req.authUser.user_id);
  if (!challenge) {
    return res.status(404).json({ error: 'Défi introuvable.' });
  }

  if (challenge.status !== 'active') {
    return res.json({ ok: true });
  }

  updateSocialChallengeStatus(id, 'resolved', winnerUserId, Date.now());
  res.json({ ok: true });
});

app.delete('/api/social-challenges/:id', authMiddleware, (req, res) => {
  const id = String(req.params.id ?? '').trim();
  const result = deleteSocialChallenge(id, req.authUser.user_id);
  if (result.changes === 0) {
    return res.status(404).json({ error: 'Défi introuvable ou déjà terminé.' });
  }
  res.json({ ok: true });
});

app.get('/api/friends/presence', authMiddleware, (req, res) => {
  const now = Date.now();
  const presences = getFriendsPresence(req.authUser.user_id)
    .map(mapPresenceRow)
    .filter(Boolean)
    .map(presence => ({
      ...presence,
      online: presence.lastSeen > 0 && now - presence.lastSeen < PRESENCE_STALE_MS
    }));

  res.json({ presences, serverTime: now });
});

app.use((_req, res) => {
  res.status(404).json({ error: 'Route introuvable.' });
});

const server = app.listen(PORT, HOST, () => {
  logServerEvent(`Démarré à ${new Date().toISOString()}`);
  logServerEvent(`Écoute sur ${HOST}:${PORT} (données: ${DATA_ROOT})`);
  logServerEvent(`Logs heartbeat: ${LOG_HEARTBEATS ? 'activés' : 'désactivés'} (LOG_HEARTBEATS=true pour tout voir)`);
  logServerEvent(`Accès local: http://localhost:${PORT}/api/health`);

  if (HOST === '127.0.0.1' || HOST === 'localhost') {
    logServerEvent(
      'ATTENTION: HOST limité à localhost — les autres machines du Wi-Fi ne pourront pas se connecter. Utilisez HOST=0.0.0.0.'
    );
  }

  const lanUrls = getLanUrls();
  if (lanUrls.length > 0) {
    logServerEvent('Adresses réseau local détectées :');
    for (const url of lanUrls) {
      logServerEvent(`  → ${url}/api/health`);
    }
  } else {
    logServerEvent('Aucune interface réseau externe détectée (Wi-Fi/Ethernet).');
  }

  const renderUrl = process.env['RENDER_EXTERNAL_URL']?.trim();
  if (renderUrl) {
    logServerEvent(`URL publique Render: ${renderUrl}/api/health`);
    logServerEvent(
      'Utilisez cette URL HTTPS dans l\'app (mode En ligne). Le plan gratuit peut mettre ~1 min à réveiller le service.'
    );
  } else {
    logServerEvent(
      `Si une autre machine échoue à se connecter, autorisez le port TCP ${PORT} dans le pare-feu Windows de la machine hôte.`
    );
  }
});

server.on('connection', socket => {
  const clientIp = normalizeIp(socket.remoteAddress ?? 'inconnu');
  const scope = isLocalClient(clientIp) ? 'LOCAL' : 'REMOTE';
  logServerEvent(`[${scope}] Connexion TCP ouverte depuis ${clientIp}:${socket.remotePort ?? '?'}`);
});

server.on('error', (error) => {
  if (error?.code === 'EADDRINUSE') {
    console.error(
      `[social-server] ERREUR : le port ${PORT} est déjà utilisé par un autre processus.`
    );
    console.error(
      '[social-server] Arrêtez l\'ancien serveur (Ctrl+C ou tuez le PID) puis relancez npm run social-server.'
    );
    console.error(
      '[social-server] Un serveur obsolète provoque des 404 sur /api/friends/requests.'
    );
    process.exit(1);
    return;
  }

  console.error('[social-server] Erreur au démarrage:', error);
  process.exit(1);
});
