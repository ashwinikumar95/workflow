import { useEffect, useState } from 'react'
import { userApi } from '../lib/api'
import { useAuth } from '../context/AuthContext'

export default function Profile() {
  const { refreshProfile } = useAuth()
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const { data } = await userApi.profile()
        if (cancelled) return
        setName(data.name || '')
        setEmail(data.email || '')
      } catch (err) {
        if (!cancelled) setError(err.response?.data?.message || err.message)
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  async function handleSubmit(e) {
    e.preventDefault()
    setMessage('')
    setError('')
    setSaving(true)
    try {
      const body = {}
      if (name.trim()) body.name = name.trim()
      if (email.trim()) body.email = email.trim()
      const { data } = await userApi.updateProfile(body)
      setMessage(data.message || 'Profile updated')
      await refreshProfile()
    } catch (err) {
      setError(err.response?.data?.message || err.message || 'Update failed')
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return (
      <div className="page-center">
        <div className="spinner" />
      </div>
    )
  }

  return (
    <div className="profile-page narrow">
      <h1>Profile</h1>
      <p className="muted">Update your name or email. Leave fields unchanged if you only edit one.</p>
      <form onSubmit={handleSubmit} className="form-stack">
        {message ? <div className="alert alert-success">{message}</div> : null}
        {error ? <div className="alert alert-error">{error}</div> : null}
        <label className="field">
          <span>Name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="field">
          <span>Email</span>
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <button type="submit" className="btn btn-primary" disabled={saving}>
          {saving ? 'Saving…' : 'Save changes'}
        </button>
      </form>
    </div>
  )
}
