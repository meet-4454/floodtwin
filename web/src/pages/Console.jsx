/* Console route — our own deployment's use of the package.
 *
 * There is deliberately no console implementation here any more. This page and
 * a partner's embed mount the SAME component with different props, so the two
 * cannot drift: anything that works here works there, and anything broken here
 * is broken for them too.
 *
 * What is specific to us: we are served from the same origin as the API, so
 * baseUrl is '' and the session cookie authenticates us (credentials:
 * 'same-origin'). A partner passes their proxy path instead, and their server
 * attaches the key.
 */
import React from 'react';
import { useNavigate } from 'react-router-dom';
import FloodTwinConsole from '../lib/FloodTwinConsole.jsx';

export default function Console() {
  const navigate = useNavigate();

  return (
    <FloodTwinConsole
      baseUrl=""
      credentials="same-origin"
      brand={{ logo: '/static/AIRESQ_LOGO.png' }}
      onExit={() => navigate('/')}
      onSignOut={async () => {
        await fetch('/api/auth/logout', {
          method: 'POST', cache: 'no-store', credentials: 'same-origin',
        }).catch(() => {});
        // A HARD navigation, not a router push. Signing out has to tear down the
        // whole tab: the three.js scene, the engine's layer handles and
        // simData's caches all live outside React and would otherwise survive
        // into the next person's session on the same machine.
        window.location.assign('/');
      }}
      // Our own origin owns the chunk hashes, so the stale-build reload in
      // controller.js is the right cure here (see `mayReload` there).
      debug={new URLSearchParams(window.location.search).has('debug')}
    />
  );
}
