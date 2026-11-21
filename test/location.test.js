'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { extractCoords, resolveLocation, splitBulk } = require('../src/location');

const near = (c, lat, lng) => {
  assert.ok(c, 'esperava coordenadas');
  assert.ok(Math.abs(c.lat - lat) < 1e-6 && Math.abs(c.lng - lng) < 1e-6, `${c.lat},${c.lng} != ${lat},${lng}`);
};

test('coordenadas soltas', () => {
  near(extractCoords('-23.5505, -46.6333'), -23.5505, -46.6333);
  near(extractCoords('Minha casa: -22.9068,-43.1729 obrigado'), -22.9068, -43.1729);
});

test('não confunde números de casa/telefone com coordenadas', () => {
  assert.strictEqual(extractCoords('Rua 12, 345 apto 6'), null);
  assert.strictEqual(extractCoords('(11) 98765-4321'), null);
});

test('links do Google Maps', () => {
  near(extractCoords('https://maps.google.com/?q=-23.5612,-46.6559'), -23.5612, -46.6559);
  near(extractCoords('https://www.google.com/maps/search/?api=1&query=-23.5612%2C-46.6559'), -23.5612, -46.6559);
  near(extractCoords('https://www.google.com/maps/place/Av.+Paulista/@-23.5614,-46.6558,17z/data=!3m1!4b1!4m6!3m5!1s0x0:0x0!8m2!3d-23.56135!4d-46.65591'), -23.56135, -46.65591);
  near(extractCoords('https://www.google.com/maps/@-23.5614,-46.6558,15z'), -23.5614, -46.6558);
  near(extractCoords('https://www.google.com/maps/place/-23.5489,-46.6388'), -23.5489, -46.6388);
});

test('geo:, Waze e OpenStreetMap', () => {
  near(extractCoords('geo:-23.5,-46.6?z=17'), -23.5, -46.6);
  near(extractCoords('https://waze.com/ul?ll=-23.55,-46.63&navigate=yes'), -23.55, -46.63);
  near(extractCoords('https://www.openstreetmap.org/?mlat=-23.55&mlon=-46.63#map=17/-23.55/-46.63'), -23.55, -46.63);
});

test('link curto é seguido até a URL com coordenadas', async () => {
  const fakeFetch = async (url) => {
    if (url.startsWith('https://maps.app.goo.gl/')) {
      return { status: 302, ok: false, headers: new Map([['location', 'https://www.google.com/maps/place/X/@-23.1,-46.2,17z/data=!3d-23.11!4d-46.22']]) };
    }
    throw new Error('não deveria buscar ' + url);
  };
  const r = await resolveLocation('Olha aqui https://maps.app.goo.gl/AbC123', { fetchImpl: fakeFetch });
  near(r, -23.11, -46.22);
  assert.strictEqual(r.method, 'link-curto');
});

test('texto colado com várias mensagens', () => {
  const items = splitBulk([
    'Maria - https://maps.google.com/?q=-23.56,-46.65',
    '',
    '21/11/2026 10:02 - João Silva: localização: https://maps.google.com/?q=-23.57,-46.66',
    'Rua Augusta, 1500, São Paulo',
    'Ana -23.5489, -46.6388',
    'Pedro - Rua das Flores, 10, Campinas',
  ].join('\n'));
  assert.strictEqual(items.length, 5);
  assert.strictEqual(items[3].name, 'Ana');
  near(extractCoords(items[3].input), -23.5489, -46.6388);
  assert.strictEqual(items[4].name, 'Pedro');
  assert.strictEqual(items[4].input, 'Rua das Flores, 10, Campinas');
  assert.strictEqual(items[0].name, 'Maria');
  assert.strictEqual(items[1].name, 'João Silva');
  near(extractCoords(items[1].input), -23.57, -46.66);
  assert.strictEqual(items[2].input, 'Rua Augusta, 1500, São Paulo');
});
