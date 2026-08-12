import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom';
import './index.css'
import Router from './Router'
import { installStartupPerformanceDiagnostics } from './Services/Performance/startupPerformance'

installStartupPerformanceDiagnostics()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <Router />
    </BrowserRouter>
  </StrictMode>
)
