ALTER TABLE projects ADD CONSTRAINT projects_tenant_project_unique UNIQUE (tenant_id, project_id);

CREATE TABLE project_folders (
  tenant_id text NOT NULL,
  project_id text NOT NULL,
  folder_id text NOT NULL,
  parent_id text,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 255 AND name NOT IN ('.', '..') AND name !~ '[/\\]'),
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, project_id, folder_id),
  FOREIGN KEY (tenant_id, project_id) REFERENCES projects (tenant_id, project_id),
  FOREIGN KEY (tenant_id, project_id, parent_id) REFERENCES project_folders (tenant_id, project_id, folder_id)
);
CREATE UNIQUE INDEX project_folder_path ON project_folders
  (tenant_id, project_id, COALESCE(parent_id, ''), lower(name)) WHERE deleted_at IS NULL;

CREATE TABLE project_files (
  tenant_id text NOT NULL,
  project_id text NOT NULL,
  file_id text NOT NULL,
  folder_id text,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 255 AND name NOT IN ('.', '..') AND name !~ '[/\\]'),
  kind text NOT NULL CHECK (kind IN ('published', 'draft', 'promoted')),
  current_version_id text NOT NULL,
  target_file_id text,
  base_version_id text,
  trashed_at timestamptz,
  created_by text NOT NULL REFERENCES users (user_id),
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, project_id, file_id),
  FOREIGN KEY (tenant_id, project_id) REFERENCES projects (tenant_id, project_id),
  FOREIGN KEY (tenant_id, project_id, folder_id) REFERENCES project_folders (tenant_id, project_id, folder_id),
  FOREIGN KEY (tenant_id, project_id, target_file_id) REFERENCES project_files (tenant_id, project_id, file_id),
  CHECK ((target_file_id IS NULL) = (base_version_id IS NULL)),
  CHECK (target_file_id IS NULL OR target_file_id <> file_id)
);
CREATE UNIQUE INDEX project_file_path ON project_files
  (tenant_id, project_id, COALESCE(folder_id, ''), lower(name))
  WHERE kind = 'published' AND trashed_at IS NULL;

CREATE TABLE project_file_versions (
  tenant_id text NOT NULL,
  project_id text NOT NULL,
  file_id text NOT NULL,
  version_id text NOT NULL,
  version_number integer NOT NULL CHECK (version_number > 0),
  storage_backend text NOT NULL CHECK (storage_backend IN ('local', 'bucket')),
  storage_key text NOT NULL,
  mime_type text NOT NULL,
  file_size_bytes bigint NOT NULL CHECK (file_size_bytes >= 0),
  checksum_sha256 text NOT NULL,
  source_artifact_id text,
  restored_from_version_id text,
  created_by text NOT NULL REFERENCES users (user_id),
  created_at timestamptz NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, project_id, file_id, version_id),
  UNIQUE (tenant_id, project_id, file_id, version_number),
  FOREIGN KEY (tenant_id, project_id, file_id) REFERENCES project_files (tenant_id, project_id, file_id)
);
ALTER TABLE project_files ADD CONSTRAINT project_files_current_version_fk
  FOREIGN KEY (tenant_id, project_id, file_id, current_version_id)
  REFERENCES project_file_versions (tenant_id, project_id, file_id, version_id)
  DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE project_files ADD CONSTRAINT project_files_base_version_fk
  FOREIGN KEY (tenant_id, project_id, target_file_id, base_version_id)
  REFERENCES project_file_versions (tenant_id, project_id, file_id, version_id);

-- Expired Trash cleanup must be implemented before release.
-- Historical versions and restored versions may share a stored object. Retention
-- cleanup must remove bytes only after every version/snapshot reference expires.
CREATE INDEX project_file_version_storage ON project_file_versions (storage_key);
CREATE FUNCTION prevent_project_version_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Project file versions are immutable';
END;
$$;
CREATE TRIGGER project_file_versions_immutable BEFORE UPDATE ON project_file_versions
  FOR EACH ROW EXECUTE FUNCTION prevent_project_version_update();

ALTER TABLE project_folders ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_folders FORCE ROW LEVEL SECURITY;
CREATE POLICY project_folders_tenant_isolation ON project_folders
  USING (tenant_id = current_setting('app.current_tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true));
ALTER TABLE project_files ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_files FORCE ROW LEVEL SECURITY;
CREATE POLICY project_files_tenant_isolation ON project_files
  USING (tenant_id = current_setting('app.current_tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true));
ALTER TABLE project_file_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_file_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY project_file_versions_tenant_isolation ON project_file_versions
  USING (tenant_id = current_setting('app.current_tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true));
