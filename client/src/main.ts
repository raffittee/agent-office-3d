// Client entry point. Until Phase 2 brings the SSE store, the 3D scene and the panels, it shows the debug page.
import { startDebugPage } from './debug/page';

const app = document.querySelector<HTMLDivElement>('#app');
if (app) startDebugPage(app);
