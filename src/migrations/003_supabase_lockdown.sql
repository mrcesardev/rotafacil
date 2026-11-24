-- Fecha o banco para a API REST automática do Supabase (PostgREST).
--
-- O Supabase publica as tabelas do schema "public" para os papéis anon e
-- authenticated, que qualquer pessoa usa com a chave pública do projeto.
-- O RotaFácil não usa essa API: só o servidor acessa o banco, conectado como
-- dono das tabelas. Então:
--   1. RLS ligado em todas as tabelas, sem políticas: anon/authenticated não
--      leem nem gravam nada. O dono das tabelas (o app) não é afetado.
--   2. A view current_stops passa a respeitar o RLS de quem consulta (PG 15+).
--   3. Os privilégios de anon/authenticated são revogados, inclusive para
--      tabelas criadas no futuro.
-- Fora do Supabase (PostgreSQL comum) os papéis não existem e só o passo 1 vale,
-- sem efeito para o app.

DO $$
DECLARE
  t record;
  r text;
BEGIN
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = current_schema() LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t.tablename);
  END LOOP;

  IF current_setting('server_version_num')::int >= 150000 THEN
    EXECUTE 'ALTER VIEW current_stops SET (security_invoker = true)';
  END IF;

  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA %I FROM %I', current_schema(), r);
      EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA %I FROM %I', current_schema(), r);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA %I REVOKE ALL ON TABLES FROM %I', current_schema(), r);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA %I REVOKE ALL ON SEQUENCES FROM %I', current_schema(), r);
    END IF;
  END LOOP;
END $$;
