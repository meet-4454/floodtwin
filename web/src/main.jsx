import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import Landing from './pages/Landing.jsx';
import Console from './pages/Console.jsx';
import RequireAuth from './components/RequireAuth.jsx';
import './styles/tokens.css';

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Landing />} />
        {/* The console mounts only after the server confirms the session — so an
            unauthenticated visitor never even downloads the simulation data. */}
        <Route path="/twin" element={<RequireAuth><Console /></RequireAuth>} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  </React.StrictMode>
);
