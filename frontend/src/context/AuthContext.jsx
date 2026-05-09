import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { authApi, getStoredUser, setSession, userApi } from '../lib/api'

const AuthContext = createContext(null)

export function AuthProvider({ children }) {
  const [user, setUser] = useState(getStoredUser)
  const [loading, setLoading] = useState(!!localStorage.getItem('token'))

  const refreshProfile = useCallback(async () => {
    if (!localStorage.getItem('token')) {
      setUser(null)
      setLoading(false)
      return
    }
    try {
      const { data } = await userApi.profile()
      setUser(data)
      setSession(localStorage.getItem('token'), data)
    } catch {
      setUser(null)
      setSession(null, null)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    refreshProfile()
  }, [refreshProfile])

  const login = useCallback(async (email, password) => {
    const { data } = await authApi.login({ email, password })
    setSession(data.token, data.user)
    setUser(data.user)
    return data
  }, [])

  const register = useCallback(async (payload) => {
    const { data } = await authApi.register(payload)
    setSession(data.token, data.user)
    setUser(data.user)
    return data
  }, [])

  const logout = useCallback(() => {
    setSession(null, null)
    setUser(null)
  }, [])

  const value = useMemo(
    () => ({
      user,
      loading,
      isAuthenticated: !!user,
      login,
      register,
      logout,
      refreshProfile,
    }),
    [user, loading, login, register, logout, refreshProfile]
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}
