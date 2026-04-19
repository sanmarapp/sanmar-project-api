/**
 * Sanmar Portal — API Client v2.0
 * Wraps all REST API calls. Handles token refresh automatically.
 * Used by both desktop.html and mobile.html.
 */
const API = (() => {
  const BASE = '/api/v1';
  let _accessToken = null;
  let _refreshPromise = null;

  // ── CORE FETCH WRAPPER ──────────────────────────────────────────
  async function req(method, path, body, retry = true) {
    const headers = { 'Content-Type': 'application/json' };
    if (_accessToken) headers['Authorization'] = `Bearer ${_accessToken}`;
    const opts = { method, headers, credentials: 'include' };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(BASE + path, opts);
    // Auto-refresh on 401 expired token
    if (res.status === 401 && retry) {
      const json = await res.json().catch(() => ({}));
      if (json.expired) {
        if (!_refreshPromise) {
          _refreshPromise = refresh().finally(() => { _refreshPromise = null; });
        }
        const ok = await _refreshPromise;
        if (ok) return req(method, path, body, false);
      }
      throw new Error('Session expired. Please log in again.');
    }
    const data = await res.json().catch(() => ({ success: false, message: 'Server error' }));
    if (!data.success && res.status >= 400) throw new Error(data.message || 'Request failed');
    return data;
  }

  async function refresh() {
    try {
      const data = await fetch(BASE + '/auth/refresh', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
      }).then(r => r.json());
      if (data.success && data.accessToken) {
        _accessToken = data.accessToken;
        return true;
      }
    } catch (_) {}
    _accessToken = null;
    return false;
  }

  // ── AUTH ────────────────────────────────────────────────────────
  async function login(email, password) {
    const data = await req('POST', '/auth/login', { email, password });
    if (data.accessToken) _accessToken = data.accessToken;
    return data;
  }
  async function logout() {
    await req('POST', '/auth/logout').catch(() => {});
    _accessToken = null;
  }
  async function getMe() { return req('GET', '/auth/me'); }

  // ── TASKS ────────────────────────────────────────────────────────
  async function getTasks(filters = {}) {
    const qs = new URLSearchParams(
      Object.fromEntries(Object.entries(filters).filter(([,v]) => v != null && v !== ''))
    ).toString();
    return req('GET', `/tasks${qs ? '?' + qs : ''}`);
  }
  async function getTask(id) { return req('GET', `/tasks/${id}`); }
  async function createTask(payload) { return req('POST', '/tasks', payload); }
  async function updateTask(id, payload) { return req('PATCH', `/tasks/${id}`, payload); }
  async function deleteTask(id) { return req('DELETE', `/tasks/${id}`); }
  async function bulkStatus(task_ids, status) { return req('POST', '/tasks/bulk-status', { task_ids, status }); }

  // ── PROJECTS ─────────────────────────────────────────────────────
  async function getProjects() { return req('GET', '/projects'); }
  async function getSOP() { return req('GET', '/projects/sop/all'); }

  // ── REPORTS ──────────────────────────────────────────────────────
  async function getSummary() { return req('GET', '/reports/summary'); }
  async function getControlTower() { return req('GET', '/reports/control-tower'); }
  async function getMeetingBoard() { return req('GET', '/reports/meeting-board'); }
  async function getWeeklySummary() { return req('GET', '/reports/weekly-summary'); }

  // ── NOTIFICATIONS ─────────────────────────────────────────────────
  async function getNotifications() { return req('GET', '/notifications'); }
  async function markNotificationsRead() { return req('POST', '/notifications/mark-read'); }

  // ── USERS ────────────────────────────────────────────────────────
  async function getUsers() { return req('GET', '/users'); }
  async function updateUser(id, payload) { return req('PATCH', `/users/${id}`, payload); }
  async function resetPassword(id, new_password) { return req('POST', `/users/${id}/reset-password`, { new_password }); }

  return {
    login, logout, getMe, refresh,
    getTasks, getTask, createTask, updateTask, deleteTask, bulkStatus,
    getProjects, getSOP,
    getSummary, getControlTower, getMeetingBoard, getWeeklySummary,
    getNotifications, markNotificationsRead,
    getUsers, updateUser, resetPassword,
    setToken: (t) => { _accessToken = t; },
  };
})();
