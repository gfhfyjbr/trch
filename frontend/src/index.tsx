/* @refresh reload */
import { render } from 'solid-js/web';
import './styles.css';
import App from './App';
import Mobile from './Mobile';

// Minimal pathname router: /mobile → phone UI, everything else → desktop UI.
const isMobileRoute = window.location.pathname.replace(/\/+$/, '') === '/mobile';

const root = document.getElementById('root');
render(() => (isMobileRoute ? <Mobile /> : <App />), root!);
