import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'

// Opcional: pequeño ErrorBoundary para no ver pantalla en blanco
function ErrorBoundary({ children }: { children: React.ReactNode }) {
  const [err, setErr] = React.useState<Error | null>(null)
  React.useEffect(() => {
    const onError = (e: ErrorEvent) => setErr(e.error ?? new Error(String(e.message)))
    const onRejection = (e: PromiseRejectionEvent) => setErr(new Error(String(e.reason)))
    window.addEventListener("error", onError)
    window.addEventListener("unhandledrejection", onRejection)
    return () => {
      window.removeEventListener("error", onError)
      window.removeEventListener("unhandledrejection", onRejection)
    }
  }, [])

  if (err) {
    return <div style={{ padding: 24, fontFamily: "sans-serif" }}>
      <h1>Ups, algo falló</h1>
      <p>Revisa la consola para detalles.</p>
      <pre style={{ whiteSpace: "pre-wrap" }}>{String(err.stack || err.message)}</pre>
    </div>
  }
  return <>{children}</>
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  // Quitar StrictMode evita dobles montajes en dev/prod
  <ErrorBoundary>
    <App />
  </ErrorBoundary>
)
