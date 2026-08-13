/* The integration, in about ten lines.
 *
 * Everything interesting is in vite.config.js (the proxy that holds the key).
 * From the browser's point of view there is no FloodTwin host and no key — just
 * a path on this origin that happens to return flood data.
 */
import React, { useState } from 'react';
import { FloodTwinConsole } from '@airesq/floodtwin-react';
import '@airesq/floodtwin-react/styles.css';

export default function App() {
  const [status, setStatus] = useState('starting…');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* A strip of host-app chrome, so it is obvious the console is embedded in
          something rather than being the page. Delete it once you believe it. */}
      <header style={{
        padding: '10px 16px', background: '#111827', color: '#e5e7eb',
        display: 'flex', gap: 12, alignItems: 'baseline', flex: '0 0 auto',
      }}>
        <strong>Your application</strong>
        <span style={{ opacity: 0.6, fontSize: 13 }}>
          FloodTwin embedded below · {status}
        </span>
      </header>

      {/* The console needs a parent with a real height — this is the single most
          common integration mistake. `flex: 1` + `minHeight: 0` gives it one. */}
      <div style={{ flex: 1, minHeight: 0 }}>
        <FloodTwinConsole
          // Your own origin. The key lives in the proxy behind this path.
          baseUrl="/api/floodtwin"

          // Your own Mappls SDK key. Without it the console asks the upstream
          // for AIResQ's, which spends their quota — see INTEGRATION.md §3.
          mapplsApiKey={import.meta.env.VITE_MAPPLS_KEY || ''}

          // Optional. Try flipping these to see the component respond.
          dataset="event"
          features={{ drainage: false }}
          brand={{ title: 'Flood Console', subtitle: 'embedded demo' }}

          onReady={(twin) => {
            setStatus('ready');
            // The live handle: fly the camera, probe depths, reach the engine.
            window.__demoTwin = twin;
            console.log('[starter] console ready. Try: __demoTwin.jumpToDeepest()');
          }}
          onError={(err) => setStatus(`failed — ${err.message}`)}
        />
      </div>
    </div>
  );
}
