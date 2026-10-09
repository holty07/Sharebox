/**
 * Sharebox — App.tsx
 *
 * Root layout for the review/workflow screens:
 *   - AuthView   (register / login, set AuthContext)
 *   - CaptureView (share destination picker — shown after login)
 *   - ItemsView  (review list, filtered by collection + search)
 *   - ItemDetail (single item: content, tags, notes, re-classify, delete)
 *
 * The currently logged-in user is held in React context (AuthContext)
 * plus `localStorage` (per-tab) so navigation reloads keep the token.
 */
import { useState, createContext, useContext, type ReactNode } from 'react';
import type { AuthTokens, Collection } from './api';
import { login as apiLogin, register as apiRegister } from './api';
import CaptureView from './components/CaptureView';
import CollectionsView from './components/CollectionsView';
import ItemsView from './components/ItemsView';
import ItemDetail from './components/ItemDetail';
import SyncStatus from './components/SyncStatus';

interface AuthContextValue {
  tokens: AuthTokens | null;
  user: { id: string; email: string; display_name: string } | null;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string, displayName: string) => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

function getSavedTokens(): AuthTokens | null {
  const t = localStorage.getItem('sharebox_access_token');
  const u = localStorage.getItem('sharebox_user');
  if (!t) return null;
  try {
    const user = u ? JSON.parse(u) : null;
    return { access_token: t, refresh_token: '', user };
  } catch {
    return null;
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [tokens, setTokens] = useState<AuthTokens | null>(getSavedTokens());
  const [user, setUser] = useState<{ id: string; email: string; display_name: string } | null>(
    getSavedTokens()?.user ?? null,
  );

  async function login(email: string, password: string) {
    const res = await apiLogin({ email, password });
    setTokens(res);
    setUser(res.user);
  }

  async function register(email: string, password: string, displayName: string) {
    const res = await apiRegister({ email, password, displayName });
    setTokens(res);
    setUser(res.user);
  }

  function logout() {
    setTokens(null);
    setUser(null);
    localStorage.removeItem('sharebox_access_token');
    localStorage.removeItem('sharebox_user');
  }

  return (
    <AuthContext.Provider value={{ tokens, user, login, register, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}

export default function App() {
  const { tokens, user, login, register, logout } = useAuth();

  // If not logged in, show the auth form.
  if (!tokens || !user) {
    return (
      <div className="app app-auth">
        <div className="auth-card">
          <header className="sheet-bar">
            <h2>Sharebox</h2>
          </header>
          <p className="auth-tagline">
            Capture anything, classify it into collections you define.
          </p>
          <div className="auth-forms">
            <LoginForm login={login} />
            <form className="auth-form" onSubmit={(e) => { e.preventDefault(); }}>
              <h3 className="auth-form-title">New here?</h3>
              <SignupForm register={register} />
            </form>
          </div>
          <p className="auth-hint">
            First run creates an "Uncategorized" collection.
          </p>
        </div>
      </div>
    );
  }

  // ---- Authenticated: shared layout ----
  return (
    <div className="app">
      <header className="app-bar">
        <div className="app-brand">
          <span className="app-logo">◉</span>
          <span>Sharebox</span>
        </div>
        <nav className="app-nav">
          <button className="nav-btn">Inbox</button>
          <button className="nav-btn">Collections</button>
        </nav>
        <div className="app-user">
          <span className="user-name">{user.display_name}</span>
          <button className="icon-btn" onClick={logout} aria-label="Sign out">
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
              <polyline points="16 17 21 12 16 7" />
              <line x1="21" y1="12" x2="9" y2="12" />
            </svg>
          </button>
        </div>
      </header>

      <SyncStatus />

      <main className="app-main">
        {/* The capture destination screen is shown as an overlay, driven
            by the ShareTarget API/deep link.  Tapping "Add to Sharebox"
            launches the same flow. */}
        <CaptureScreen />

        {/* Review: item list.  CollectionId is null → show all + Uncategorized
             scopes are handled inside ItemsView. */}
        <ItemsView
          collectionId={null}
          placeholder="Add to Sharebox"
          title="Inbox"
        />
      </main>
    </div>
  );
}

/** Overlay that renders CaptureView (the share destination picker). */
function CaptureScreen() {
  const [showPicker, setShowPicker] = useState(true);
  const [placeholder, setPlaceholder] = useState('Add to Sharebox');

  if (!showPicker) return null;

  return (
    <div className="overlay" onClick={() => setShowPicker(false)}>
      <div
        className="sheet capture-sheet"
        onClick={(e) => e.stopPropagation()}
      >
        <CaptureView
          onPick={async (col) => {
            // Remember the chosen collection (or null for Uncategorized).
            localStorage.setItem('sharebox_destination', col?.id ?? 'uncategorized');
            // After picking, show the review list.
            setShowPicker(false);
          }}
          placeholder={placeholder}
          onClose={() => setShowPicker(false)}
        />
      </div>
    </div>
  );
}

/** Simple login form. */
function LoginForm({ login }: { login: (email: string, password: string) => Promise<void> }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    try {
      await login(email, password);
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  return (
    <form className="auth-form" onSubmit={handleSubmit}>
      <h3 className="auth-form-title">Welcome back</h3>
      {err && <div className="auth-error">{err}</div>}
      <input
        className="field-input"
        type="email"
        placeholder="Email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        required
      />
      <input
        className="field-input"
        type="password"
        placeholder="Password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        required
        minLength={8}
      />
      <button className="btn primary block" type="submit">Sign in</button>
    </form>
  );
}

/** Simple signup form. */
function SignupForm({ register }: { register: (email: string, password: string, displayName: string) => Promise<void> }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [err, setErr] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    try {
      await register(email, password, displayName);
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  return (
    <form className="auth-form" onSubmit={handleSubmit}>
      <h3 className="auth-form-title">Create your workspace</h3>
      {err && <div className="auth-error">{err}</div>}
      <input
        className="field-input"
        type="text"
        placeholder="Display name"
        value={displayName}
        onChange={(e) => setDisplayName(e.target.value)}
        required
      />
      <input
        className="field-input"
        type="email"
        placeholder="Email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        required
      />
      <input
        className="field-input"
        type="password"
        placeholder="Password (8+ chars)"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        required
        minLength={8}
      />
      <button className="btn primary block" type="submit">Create account</button>
    </form>
  );
}
