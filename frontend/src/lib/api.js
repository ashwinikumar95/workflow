import axios from 'axios'

const baseURL = import.meta.env.VITE_API_URL || ''

export const api = axios.create({
  baseURL: baseURL || undefined,
  headers: { 'Content-Type': 'application/json' },
})

api.interceptors.request.use((config) => {
  const token = localStorage.getItem('token')
  if (token) {
    config.headers.Authorization = `Bearer ${token}`
  }
  return config
})

api.interceptors.response.use(
  (r) => r,
  (err) => {
    if (err.response?.status === 401) {
      const path = window.location.pathname
      const publicAuth = path === '/login' || path === '/register'
      if (!publicAuth) {
        localStorage.removeItem('token')
        localStorage.removeItem('user')
        window.location.href = '/login'
      }
    }
    return Promise.reject(err)
  }
)

export function setSession(token, user) {
  if (token) localStorage.setItem('token', token)
  else localStorage.removeItem('token')
  if (user) localStorage.setItem('user', JSON.stringify(user))
  else localStorage.removeItem('user')
}

export function getStoredUser() {
  try {
    const raw = localStorage.getItem('user')
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

export const authApi = {
  login: (body) => api.post('/auth/login', body),
  register: (body) => api.post('/auth/register', body),
}

export const workflowApi = {
  list: () => api.get('/workflow'),
  get: (id) => api.get(`/workflow/${id}`),
  create: (body) => api.post('/workflow', body),
  patch: (id, body) => api.patch(`/workflow/${id}`, body),
  patchTriggerEnabled: (id, enabled) =>
    api.patch(`/workflow/${id}/trigger-enabled`, { enabled }),
  publish: (id) => api.post(`/workflow/${id}/publish`),
  start: (id, body) => api.post(`/workflow/${id}/start`, body ?? {}),
  runs: (id, params) => api.get(`/workflow/${id}/runs`, { params }),
  delete: (id) => api.delete(`/workflow/${id}`),
}

export const runApi = {
  get: (runId) => api.get(`/runs/${runId}`),
}

export const userApi = {
  profile: () => api.get('/user/profile'),
  updateProfile: (body) => api.patch('/user/profile', body),
}

export function webhookUrl(workflowId) {
  const origin = baseURL.replace(/\/$/, '') || window.location.origin
  return `${origin}/webhook/${workflowId}`
}
