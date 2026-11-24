-- RotaFácil: esquema inicial (PostgreSQL)
-- Convenções:
--  * todo instante é timestamptz (gravado em UTC); "date" é o dia no fuso da organização
--  * toda tabela de negócio tem org_id (isolamento entre clientes do SaaS)
--  * nada de histórico é sobrescrito: rotas têm versões, posições e eventos são acumulados

CREATE TABLE organizations (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name             text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  timezone         text NOT NULL DEFAULT 'America/Sao_Paulo',
  depot_address    text,
  depot_lat        double precision CHECK (depot_lat BETWEEN -90 AND 90),
  depot_lng        double precision CHECK (depot_lng BETWEEN -180 AND 180),
  start_time       time NOT NULL DEFAULT '08:00',
  service_minutes  integer NOT NULL DEFAULT 3 CHECK (service_minutes BETWEEN 0 AND 120),
  return_to_start  boolean NOT NULL DEFAULT false,
  retention_days   integer NOT NULL DEFAULT 365 CHECK (retention_days BETWEEN 30 AND 3650),
  whatsapp_phone_number_id text UNIQUE,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CHECK ((depot_lat IS NULL) = (depot_lng IS NULL))
);

CREATE TABLE users (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id         bigint NOT NULL REFERENCES organizations ON DELETE CASCADE,
  name           text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  email          text NOT NULL,
  password_hash  text NOT NULL,
  role           text NOT NULL CHECK (role IN ('dono', 'operador')),
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_key ON users (lower(email));
CREATE INDEX users_org_idx ON users (org_id);

-- só o hash SHA-256 do token fica no banco; o token em si existe apenas no cookie
CREATE TABLE sessions (
  token_hash  text PRIMARY KEY,
  user_id     bigint NOT NULL REFERENCES users ON DELETE CASCADE,
  expires_at  timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_expires_idx ON sessions (expires_at);
CREATE INDEX sessions_user_idx ON sessions (user_id);

CREATE TABLE drivers (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id       bigint NOT NULL REFERENCES organizations ON DELETE CASCADE,
  name         text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  phone        text,
  archived_at  timestamptz,           -- removido da equipe; o histórico continua
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX drivers_org_idx ON drivers (org_id) WHERE archived_at IS NULL;

-- histórico de onde o entregador estava (ponto de partida das rotas)
CREATE TABLE driver_positions (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id       bigint NOT NULL REFERENCES organizations ON DELETE CASCADE,
  driver_id    bigint NOT NULL REFERENCES drivers ON DELETE CASCADE,
  lat          double precision NOT NULL CHECK (lat BETWEEN -90 AND 90),
  lng          double precision NOT NULL CHECK (lng BETWEEN -180 AND 180),
  source       text NOT NULL CHECK (source IN ('whatsapp', 'mapa', 'gps')),
  label        text,
  recorded_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX driver_positions_driver_idx ON driver_positions (driver_id, recorded_at DESC);
CREATE INDEX driver_positions_org_idx ON driver_positions (org_id, recorded_at);

CREATE TABLE customers (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id         bigint NOT NULL REFERENCES organizations ON DELETE CASCADE,
  name           text,
  phone          text,
  phone_digits   text,                -- normalizado (55 + DDD + número) para achar o cliente recorrente
  anonymized_at  timestamptz,         -- dados pessoais apagados (LGPD); a linha fica para as estatísticas
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX customers_phone_key ON customers (org_id, phone_digits) WHERE phone_digits IS NOT NULL;
CREATE INDEX customers_name_idx ON customers (org_id, lower(name));

-- locais já usados/confirmados pelo cliente, reaproveitados na próxima entrega
CREATE TABLE customer_places (
  id                     bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id                 bigint NOT NULL REFERENCES organizations ON DELETE CASCADE,
  customer_id            bigint NOT NULL REFERENCES customers ON DELETE CASCADE,
  lat                    double precision NOT NULL CHECK (lat BETWEEN -90 AND 90),
  lng                    double precision NOT NULL CHECK (lng BETWEEN -180 AND 180),
  address                text,
  reference              text,
  confirmed_by_customer  boolean NOT NULL DEFAULT false,
  last_used_at           timestamptz NOT NULL DEFAULT now(),
  created_at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX customer_places_customer_idx ON customer_places (customer_id, last_used_at DESC);

CREATE TABLE deliveries (
  id                     bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id                 bigint NOT NULL REFERENCES organizations ON DELETE CASCADE,
  date                   date NOT NULL,
  customer_id            bigint NOT NULL REFERENCES customers ON DELETE RESTRICT,
  driver_id              bigint REFERENCES drivers ON DELETE SET NULL,   -- atribuição feita pelo operador
  -- onde entregar (fotografia do local desta entrega)
  lat                    double precision CHECK (lat BETWEEN -90 AND 90),
  lng                    double precision CHECK (lng BETWEEN -180 AND 180),
  address                text,
  reference              text,                                            -- escrita pelo cliente; o entregador vê
  location_source        text CHECK (location_source IN ('colado', 'mapa', 'cliente', 'whatsapp', 'recorrente', 'manual')),
  raw_input              text,
  source                 text NOT NULL CHECK (source IN ('manual', 'colado', 'link', 'whatsapp')),
  notes                  text,                                            -- interna: nunca vai para o cliente
  status                 text NOT NULL DEFAULT 'pendente' CHECK (status IN ('pendente', 'entregue', 'falhou')),
  completed_at           timestamptz,
  public_token           text UNIQUE,                                     -- link do cliente
  customer_confirmed_at  timestamptz,
  consent_at             timestamptz,
  consent_version        text,
  created_at             timestamptz NOT NULL DEFAULT now(),
  CHECK ((lat IS NULL) = (lng IS NULL)),
  CHECK ((status = 'pendente') = (completed_at IS NULL)),
  CHECK ((consent_at IS NULL) = (consent_version IS NULL))
);
CREATE INDEX deliveries_org_date_idx ON deliveries (org_id, date);
CREATE INDEX deliveries_driver_date_idx ON deliveries (driver_id, date) WHERE driver_id IS NOT NULL;
CREATE INDEX deliveries_customer_idx ON deliveries (customer_id);

-- uma rota por entregador por dia; o token (link do entregador) não muda ao recalcular
CREATE TABLE routes (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id           bigint NOT NULL REFERENCES organizations ON DELETE CASCADE,
  driver_id        bigint NOT NULL REFERENCES drivers ON DELETE CASCADE,
  date             date NOT NULL,
  token            text NOT NULL UNIQUE,
  current_plan_id  bigint,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (driver_id, date)
);
CREATE INDEX routes_org_date_idx ON routes (org_id, date);

-- cada geração ou recálculo da rota é uma versão nova (nada é sobrescrito)
CREATE TABLE route_plans (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  route_id       bigint NOT NULL REFERENCES routes ON DELETE CASCADE,
  version        integer NOT NULL CHECK (version >= 1),
  start_lat      double precision CHECK (start_lat BETWEEN -90 AND 90),
  start_lng      double precision CHECK (start_lng BETWEEN -180 AND 180),
  start_source   text NOT NULL CHECK (start_source IN ('entregador', 'base')),
  base_time      timestamptz NOT NULL,          -- de quando partem as previsões
  distance_m     double precision NOT NULL CHECK (distance_m >= 0),
  duration_s     double precision NOT NULL CHECK (duration_s >= 0),
  geometry       jsonb,
  engine         text NOT NULL,
  matrix_source  text NOT NULL,
  created_by     text NOT NULL CHECK (created_by IN ('operador', 'entregador')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (route_id, version)
);
ALTER TABLE routes ADD CONSTRAINT routes_current_plan_fk
  FOREIGN KEY (current_plan_id) REFERENCES route_plans ON DELETE SET NULL;

CREATE TABLE route_stops (
  plan_id      bigint NOT NULL REFERENCES route_plans ON DELETE CASCADE,
  delivery_id  bigint NOT NULL REFERENCES deliveries ON DELETE CASCADE,
  seq          integer NOT NULL CHECK (seq >= 1),
  eta          timestamptz,
  PRIMARY KEY (plan_id, delivery_id),
  UNIQUE (plan_id, seq)
);
CREATE INDEX route_stops_delivery_idx ON route_stops (delivery_id);

-- Paradas valendo agora: versão atual de cada rota, e só se a entrega ainda for
-- daquele entregador. Assim a rota e a atribuição nunca ficam contraditórias.
CREATE VIEW current_stops AS
SELECT r.id AS route_id, r.org_id, r.driver_id, r.date, rs.delivery_id, rs.seq, rs.eta
FROM routes r
JOIN route_stops rs ON rs.plan_id = r.current_plan_id
JOIN deliveries d ON d.id = rs.delivery_id AND d.driver_id = r.driver_id;

-- registro de tudo que acontece (base para relatórios e melhorias)
CREATE TABLE events (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id       bigint NOT NULL REFERENCES organizations ON DELETE CASCADE,
  at           timestamptz NOT NULL DEFAULT now(),
  type         text NOT NULL,
  actor_type   text NOT NULL CHECK (actor_type IN ('usuario', 'entregador', 'cliente', 'sistema')),
  user_id      bigint REFERENCES users ON DELETE SET NULL,
  driver_id    bigint REFERENCES drivers ON DELETE SET NULL,
  delivery_id  bigint REFERENCES deliveries ON DELETE SET NULL,
  route_id     bigint REFERENCES routes ON DELETE SET NULL,
  lat          double precision,
  lng          double precision,
  data         jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX events_org_at_idx ON events (org_id, at DESC);
CREATE INDEX events_delivery_idx ON events (delivery_id) WHERE delivery_id IS NOT NULL;
CREATE INDEX events_type_idx ON events (org_id, type, at DESC);
