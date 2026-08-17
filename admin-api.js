
// FarmDirect Admin Panel — admin-api.js
// Separate API client for the standalone admin panel.
// Talks to the same backend but is completely isolated
// from the buyer/farmer/courier frontend.
// ============================================================

const ADMIN_API_BASE = 'https://your-app.onrender.com/api';
// Change above to your Render URL after deployment.
// During development use: 'http://localhost:5000/api'

const AdminAPI = (() => {

  const ok  = (data, message='') => ({ success:true, data, message });
  const err = (message, code=400) => ({ success:false, message, code });

  const getToken = () => {
    try { return sessionStorage.getItem('fd_admin_token') || null; }
    catch { return null; }
  };
  const setToken = (t) => { try { sessionStorage.setItem('fd_admin_token', t); } catch {} };
  const clearToken= () => { try { sessionStorage.removeItem('fd_admin_token'); } catch {} };

  const call = async (method, endpoint, body=null, isForm=false) => {
    try {
      const headers = {};
      const token   = getToken();
      if (!isForm) headers['Content-Type'] = 'application/json';
      if (token)   headers['Authorization'] = `Bearer ${token}`;
      const options = {
        method, headers,
        ...(body && !isForm ? { body: JSON.stringify(body) } : {}),
        ...(body &&  isForm ? { body } : {}),
      };
      const res  = await fetch(ADMIN_API_BASE + endpoint, options);
      const json = await res.json();
      if (res.status === 401) {
        clearToken();
        window.location.href = '/auth/login.html';
        return err('Session expired', 401);
      }
      if (json.success) return ok(json.data, json.message);
      return err(json.error || json.message || 'Request failed', res.status);
    } catch(e) {
      return err('Cannot connect to backend: ' + e.message, 0);
    }
  };

  return {
    getToken, setToken, clearToken,

    async login(phone, password) {
      const result = await call('POST', '/auth/login', { identifier: phone, password });
      if (result.success && result.data?.token) {
        // Verify this is actually an admin
        if (result.data.user?.role !== 'admin') {
          return err('Access denied. Admin accounts only.');
        }
        setToken(result.data.token);
        sessionStorage.setItem('fd_admin_user', JSON.stringify(result.data.user));
        return ok(result.data.user, result.message);
      }
      return result;
    },

    logout() {
      clearToken();
      sessionStorage.removeItem('fd_admin_user');
      window.location.href = '/auth/login.html';
    },

    getSession() {
      try {
        const raw = sessionStorage.getItem('fd_admin_user');
        return raw ? JSON.parse(raw) : null;
      } catch { return null; }
    },

    requireAdmin() {
      const session = this.getSession();
      if (!session || session.role !== 'admin') {
        window.location.href = '/auth/login.html';
        return false;
      }
      return session;
    },

    // Stats & Analytics
    async getStats()     { return call('GET', '/admin/stats'); },
    async getAnalytics() { return call('GET', '/admin/analytics'); },
    async getPublicStats(){ return call('GET', '/admin/public-stats'); },

    // Users
    async getUsers(filters={}) {
      const p = new URLSearchParams();
      Object.entries(filters).forEach(([k,v]) => { if(v) p.append(k,v); });
      return call('GET', `/admin/users${p.toString() ? '?'+p.toString() : ''}`);
    },
    async getUser(id)           { return call('GET', `/admin/users/${id}`); },
    async getUserDocuments(id)  { return call('GET', `/admin/users/${id}/documents`); },
    async setUserStatus(id, status, reason='') {
      return call('PATCH', `/admin/users/${id}/status`, { status, reason });
    },

    // Orders
    async getOrders(filters={}) {
      const q = filters.status ? `?status=${filters.status}` : '';
      return call('GET', `/admin/orders${q}`);
    },

    // Payments
    async getPayments(page=1) { return call('GET', `/admin/payments?page=${page}`); },

    // Courier jobs
    async getCourierJobs(status) {
      const q = status ? `?status=${status}` : '';
      return call('GET', `/admin/courier-jobs${q}`);
    },
  };
})();
