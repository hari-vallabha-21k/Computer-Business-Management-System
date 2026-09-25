/* Thin fetch wrapper. Every failure surfaces a readable message (PRD section 32). */
(function () {
  'use strict';

  const state = {
    token: localStorage.getItem('cbms_token') || null,
    user: null, business: null, permissions: {},
  };

  class ApiError extends Error {
    constructor(message, status, details) {
      super(message);
      this.status = status;
      this.details = details;
    }
  }

  async function request(method, path, body, options = {}) {
    const headers = {};
    if (state.token) headers.authorization = `Bearer ${state.token}`;
    let payload = body;
    if (body !== undefined && !(body instanceof FormData)) {
      headers['content-type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    let res;
    try {
      res = await fetch(path, { method, headers, body: payload });
    } catch (err) {
      throw new ApiError('Could not reach the server. Check your connection and try again.', 0);
    }
    if (res.status === 401 && !options.allowAnonymous) {
      state.token = null;
      localStorage.removeItem('cbms_token');
      window.dispatchEvent(new CustomEvent('cbms:signed-out'));
      throw new ApiError('Your session has expired. Please sign in again.', 401);
    }
    if (options.raw) return res;
    const text = await res.text();
    let data;
    try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
    if (!res.ok) throw new ApiError(data.error || `Request failed (${res.status}).`, res.status, data.details);
    return data;
  }

  const qs = (params = {}) => {
    const search = new URLSearchParams();
    Object.entries(params).forEach(([k, v]) => {
      if (v !== undefined && v !== null && v !== '') search.set(k, v);
    });
    const s = search.toString();
    return s ? `?${s}` : '';
  };

  const api = {
    state,
    ApiError,
    qs,
    get: (path, params) => request('GET', path + qs(params)),
    post: (path, body) => request('POST', path, body),
    put: (path, body) => request('PUT', path, body),
    del: (path, body) => request('DELETE', path, body),
    raw: (path, params) => request('GET', path + qs(params), undefined, { raw: true }),

    async login(email, password) {
      const data = await request('POST', '/api/auth/login', { email, password }, { allowAnonymous: true });
      state.token = data.token;
      state.user = data.user;
      localStorage.setItem('cbms_token', data.token);
      return data.user;
    },

    async logout() {
      try { await request('POST', '/api/auth/logout'); } catch { /* signing out locally is enough */ }
      state.token = null;
      state.user = null;
      localStorage.removeItem('cbms_token');
    },

    async me() {
      if (!state.token) return null;
      const data = await request('GET', '/api/auth/me');
      state.user = data.user;
      state.business = data.business;
      state.permissions = data.permissions || {};
      return data.user;
    },

    isAdmin: () => !!state.user && state.user.role === 'ADMIN',

    /** What this user may do. The owner may do everything. */
    can: (key) => (state.user && state.user.role === 'ADMIN') || state.permissions[key] === true,

    /** Open an authenticated download (PDF / CSV) in a new tab-free blob link. */
    async download(path, params, filename) {
      const res = await request('GET', path + qs(params), undefined, { raw: true });
      if (!res.ok) throw new ApiError('The file could not be generated.', res.status);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename || 'download';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
    },

    async openPdf(path) {
      const res = await request('GET', path, undefined, { raw: true });
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      window.open(url, '_blank');
      setTimeout(() => URL.revokeObjectURL(url), 20000);
    },
  };

  window.api = api;
})();
