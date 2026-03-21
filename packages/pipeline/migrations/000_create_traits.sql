-- Trait catalog with normalized PGS metadata (no JSON columns)

-- Core trait information
CREATE TABLE IF NOT EXISTS traits (
  trait_id VARCHAR PRIMARY KEY,
  name VARCHAR NOT NULL,
  description VARCHAR,
  categories VARCHAR,
  unit VARCHAR,
  emoji VARCHAR,
  trait_type VARCHAR,
  editorial_name VARCHAR,
  editorial_description VARCHAR,
  phenotype_mean DOUBLE,
  phenotype_sd DOUBLE,
  reference_population VARCHAR,
  expected_variants BIGINT,
  estimated_unique_variants BIGINT,
  metadata_hash VARCHAR,
  last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- PGS metadata (centralized, deduplicated)
CREATE TABLE IF NOT EXISTS pgs_scores (
  pgs_id VARCHAR PRIMARY KEY,
  weight_type VARCHAR,
  method_name VARCHAR,
  norm_mean DOUBLE,
  norm_sd DOUBLE,
  variants_number BIGINT,  -- Raw variant count from PGS Catalog metadata
  variants_in_parquet BIGINT,  -- Actual variant count in parquet files after LD clumping/filtering
  ld_aware BOOLEAN DEFAULT false,
  needs_clumping BOOLEAN DEFAULT false,
  last_updated TIMESTAMP DEFAULT now()
);

-- Performance metrics (one row per metric)
CREATE SEQUENCE IF NOT EXISTS pgs_performance_seq START 1;
CREATE TABLE IF NOT EXISTS pgs_performance (
  id INTEGER PRIMARY KEY DEFAULT nextval('pgs_performance_seq'),
  pgs_id VARCHAR NOT NULL,
  metric_type VARCHAR NOT NULL,
  metric_value DOUBLE NOT NULL,
  ci_lower DOUBLE,
  ci_upper DOUBLE,
  sample_size BIGINT,
  ancestry VARCHAR
);

-- Trait → PGS associations
CREATE TABLE IF NOT EXISTS trait_pgs (
  trait_id VARCHAR NOT NULL,
  pgs_id VARCHAR NOT NULL,
  performance_weight DOUBLE DEFAULT 0.5,
  PRIMARY KEY (trait_id, pgs_id)
);

-- Excluded PGS with reasons
CREATE TABLE IF NOT EXISTS trait_excluded_pgs (
  trait_id VARCHAR NOT NULL,
  pgs_id VARCHAR NOT NULL,
  reason VARCHAR NOT NULL,
  method VARCHAR,
  weight_type VARCHAR,
  PRIMARY KEY (trait_id, pgs_id)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_pgs_perf_id ON pgs_performance(pgs_id);
CREATE INDEX IF NOT EXISTS idx_trait_pgs_trait ON trait_pgs(trait_id);
CREATE INDEX IF NOT EXISTS idx_trait_pgs_pgs ON trait_pgs(pgs_id);
