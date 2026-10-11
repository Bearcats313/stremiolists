import crypto from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { db, getSetting, setSetting } from './db.js';

const SESSION_COOKIE = 'sid';
const SESSION_TTL = 30 * 24 * 3600_000;

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(password: string, stored: string | null): boolean {
  if (!stored) return false;
  const [scheme, saltB64, hashB64] = stored.split('$');
  if (scheme !== 'scrypt' || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = crypto.scryptSync(password, Buffer.from(saltB64, 'base64'), expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

export function setPassword(password: string) {
  setSetting('admin_password_hash', hashPassword(password));
  // Changing the password signs out every session.
  db().prepare('DELETE FROM sessions').run();
}

export function hasPassword() {
  return !!getSetting('admin_password_hash');
}

export function createSession(req: FastifyRequest, reply: FastifyReply) {
  const id = crypto.randomBytes(32).toString('base64url');
  db().prepare('INSERT INTO sessions (id, expires_at) VALUES (?, ?)').run(id, Date.now() + SESSION_TTL);
  reply.setCookie(SESSION_COOKIE, id, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: req.protocol === 'https',
    maxAge: SESSION_TTL / 1000,
  });
}

export function destroySession(req: FastifyRequest, reply: FastifyReply) {
  const id = req.cookies[SESSION_COOKIE];
  if (id) db().prepare('DELETE FROM sessions WHERE id = ?').run(id);
  reply.clearCookie(SESSION_COOKIE, { path: '/' });
}

export function isLoggedIn(req: FastifyRequest): boolean {
  const id = req.cookies[SESSION_COOKIE];
  if (!id) return false;
  const row = db().prepare('SELECT expires_at FROM sessions WHERE id = ?').get(id) as { expires_at: number } | undefined;
  return !!row && row.expires_at > Date.now();
}

export function purgeExpiredSessions() {
  db().prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
}

// Slow down password guessing: one failed attempt per IP per second, tracked in memory.
const lastFailure = new Map<string, number>();
export function loginThrottled(ip: string) {
  const t = lastFailure.get(ip);
  return t !== undefined && Date.now() - t < 1000;
}
export function recordLoginFailure(ip: string) {
  lastFailure.set(ip, Date.now());
  if (lastFailure.size > 1000) lastFailure.clear();
}
