CREATE TABLE IF NOT EXISTS users (
  id BIGSERIAL PRIMARY KEY,
  name VARCHAR(120) NOT NULL,
  username VARCHAR(60) UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role VARCHAR(20) NOT NULL CHECK (role IN ('admin','helper')),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS attendance (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id),
  work_date DATE NOT NULL,
  entry_at TIMESTAMPTZ NOT NULL,
  exit_at TIMESTAMPTZ,
  entry_lat DOUBLE PRECISION,
  entry_lng DOUBLE PRECISION,
  entry_accuracy DOUBLE PRECISION,
  exit_lat DOUBLE PRECISION,
  exit_lng DOUBLE PRECISION,
  exit_accuracy DOUBLE PRECISION,
  replacement_day BOOLEAN NOT NULL DEFAULT FALSE,
  status VARCHAR(20) NOT NULL DEFAULT 'open' CHECK (status IN ('open','complete')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, work_date)
);

CREATE TABLE IF NOT EXISTS evidence (
  id BIGSERIAL PRIMARY KEY,
  attendance_id BIGINT NOT NULL REFERENCES attendance(id) ON DELETE CASCADE,
  kind VARCHAR(20) NOT NULL CHECK (kind IN ('entry','exit')),
  file_name TEXT NOT NULL,
  original_name TEXT,
  mime_type TEXT NOT NULL,
  latitude DOUBLE PRECISION,
  longitude DOUBLE PRECISION,
  accuracy DOUBLE PRECISION,
  captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS activities (
  id SERIAL PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS attendance_activities (
  attendance_id BIGINT NOT NULL REFERENCES attendance(id) ON DELETE CASCADE,
  activity_id INTEGER NOT NULL REFERENCES activities(id),
  PRIMARY KEY(attendance_id, activity_id)
);

CREATE TABLE IF NOT EXISTS schedules (
  id BIGSERIAL PRIMARY KEY,
  year INTEGER NOT NULL,
  month INTEGER NOT NULL CHECK(month BETWEEN 1 AND 12),
  file_name TEXT NOT NULL,
  original_name TEXT NOT NULL,
  uploaded_by BIGINT NOT NULL REFERENCES users(id),
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(year, month)
);

CREATE TABLE IF NOT EXISTS cronograms (
  id BIGSERIAL PRIMARY KEY,
  year INTEGER NOT NULL,
  month INTEGER NOT NULL CHECK(month BETWEEN 1 AND 12),
  file_name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(year, month)
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS audit_log (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT REFERENCES users(id),
  action TEXT NOT NULL,
  detail JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO activities(name) VALUES
('Limpieza del jardín principal.'),
('Limpieza de las aceras de la calle principal.'),
('Fumigación de áreas verdes.'),
('Poda de limoncillo en la calle principal.'),
('Corte de césped en casas deshabitadas.'),
('Mantenimiento de áreas verdes.'),
('Corte de grama en la servidumbre principal.'),
('Podas generales.'),
('Poda de durantas y plantas ornamentales.'),
('Fumigación para control de maleza.'),
('Mantenimiento del parque.'),
('Limpieza de aceras.'),
('Poda y fumigación.'),
('Limpieza de la planta de tratamiento.'),
('Fumigación de la calle principal.'),
('Limpieza de ixoras del área principal.'),
('Aplicación de abono en áreas verdes.'),
('Limpieza y mantenimiento de jardines.'),
('Lavado de aceras con hidrolavadora.'),
('Lavado del parque con hidrolavadora.')
ON CONFLICT (name) DO NOTHING;
