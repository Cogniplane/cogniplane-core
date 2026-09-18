-- Session and project-file GC resolve live object references by storage key.
-- Keep deleted artifacts out of this index because they do not keep objects
-- alive during either cleanup path.
CREATE INDEX IF NOT EXISTS idx_artifacts_storage_key
  ON artifacts (storage_key)
  WHERE status <> 'deleted';
