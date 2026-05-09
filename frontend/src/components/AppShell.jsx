import { Link, NavLink, Outlet, useLocation } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'

export default function AppShell() {
  const { user, logout } = useAuth()
  const location = useLocation()
  const editorBleed = /^\/workflows\//.test(location.pathname)

  return (
    <div className="app-shell">
      <header className="top-nav">
        <Link to="/" className="brand brand-future">
          <span className="brand-glow">Flow</span>
          <span className="brand-dim">Forge</span>
        </Link>
        <nav className="nav-links">
          <NavLink to="/" end className={({ isActive }) => (isActive ? 'active' : '')}>
            Workflows
          </NavLink>
          <NavLink
            to="/profile"
            className={({ isActive }) => (isActive ? 'active' : '')}
          >
            Profile
          </NavLink>
        </nav>
        <div className="nav-user">
          <span className="muted">{user?.name || user?.email}</span>
          <button type="button" className="btn btn-ghost" onClick={logout}>
            Sign out
          </button>
        </div>
      </header>
      <main className={editorBleed ? 'main-area main-area--bleed' : 'main-area'}>
        <Outlet />
      </main>
    </div>
  )
}
