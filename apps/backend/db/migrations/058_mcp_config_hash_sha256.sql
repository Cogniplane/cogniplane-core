-- Migration 053 and older seeds stored MD5 hashes (32 hex characters). The
-- application writes SHA-256 hashes, and connection tests accept only that
-- format. The hash is an opaque change token, so derive a SHA-256 value from
-- each legacy hash. The next save replaces it with the computed config hash.
UPDATE admin_mcp_servers
  SET config_hash = encode(sha256(convert_to(config_hash, 'UTF8')), 'hex')
  WHERE config_hash !~ '^[a-f0-9]{64}$';
