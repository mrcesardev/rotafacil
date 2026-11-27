#!/usr/bin/env node
'use strict';
/**
 * Build da Vercel (Build Output API v3): publica as páginas de public/ e
 * repassa a API para o servidor na VPS.
 *
 *   API_ORIGIN=https://api.seudominio.com.br node scripts/build-vercel.js
 *
 * As chamadas /api/* e /webhooks/* vão para API_ORIGIN pelo mesmo domínio do
 * site, então não há CORS e o cookie de login funciona normalmente.
 */
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const out = path.join(root, '.vercel', 'output');
const stat = path.join(out, 'static');

const origin = (process.env.API_ORIGIN || '').replace(/\/+$/, '');
if (!/^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(origin)) {
  console.error('Defina API_ORIGIN nas variáveis de ambiente da Vercel, ex.: https://api.seudominio.com.br');
  process.exit(1);
}

fs.rmSync(out, { recursive: true, force: true });
fs.cpSync(path.join(root, 'public'), stat, { recursive: true });
fs.cpSync(path.dirname(require.resolve('leaflet/dist/leaflet.js')), path.join(stat, 'vendor', 'leaflet'), { recursive: true });

const noStore = { 'Cache-Control': 'no-store' };
const config = {
  version: 3,
  routes: [
    // API e webhook do WhatsApp: repassados para a VPS
    { src: '^/api/(.*)$', dest: `${origin}/api/$1`, headers: noStore },
    { src: '^/webhooks/(.*)$', dest: `${origin}/webhooks/$1` },
    // mesmos cabeçalhos de segurança do Caddy
    {
      src: '/(.*)',
      headers: {
        'Strict-Transport-Security': 'max-age=31536000',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'strict-origin-when-cross-origin',
        'Permissions-Policy': 'geolocation=(self), camera=(), microphone=()',
      },
      continue: true,
    },
    { src: '^/vendor/(.*)$', headers: { 'Cache-Control': 'public, max-age=604800' }, continue: true },
    { handle: 'filesystem' },
    // páginas com endereço próprio (as mesmas rotas do src/server.js)
    { src: '^/e/[^/]+/?$', dest: '/driver.html' },
    { src: '^/r/[^/]+/?$', dest: '/recipient.html' },
    { src: '^/relatorios/?$', dest: '/reports.html' },
    { src: '^/(driver|recipient|reports)$', dest: '/$1.html' },
  ],
};
fs.writeFileSync(path.join(out, 'config.json'), JSON.stringify(config, null, 2));
console.log(`Build pronto em .vercel/output (API em ${origin})`);
