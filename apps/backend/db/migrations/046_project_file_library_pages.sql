CREATE INDEX project_files_library_updated ON project_files
  (tenant_id, project_id, updated_at DESC, file_id DESC)
  WHERE kind <> 'promoted';

CREATE INDEX project_files_library_name ON project_files
  (tenant_id, project_id, lower(name), file_id)
  WHERE kind <> 'promoted';

CREATE INDEX project_folders_live_name ON project_folders
  (tenant_id, project_id, lower(name), folder_id)
  WHERE deleted_at IS NULL;
