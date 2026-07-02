DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agent_memory_app') THEN
    GRANT DELETE ON agent_observations TO agent_memory_app;
  END IF;
END
$$;
