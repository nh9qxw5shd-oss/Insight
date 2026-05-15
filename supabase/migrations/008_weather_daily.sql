-- Insight — Daily weather observations and 7-day forecasts per EMCC route area.
-- Populated from Open-Meteo API (archive + forecast endpoints, no API key required).
-- One row per (area, date); upsert on conflict refreshes forecast data as days mature.

CREATE TABLE IF NOT EXISTS weather_daily (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  area            text        NOT NULL,
  date            date        NOT NULL,

  -- Temperature
  min_temp_c      numeric(4,1),
  max_temp_c      numeric(4,1),

  -- Precipitation
  rainfall_mm     numeric(6,2),

  -- Wind
  max_wind_kmh    numeric(6,1),
  wind_dir_deg    smallint,           -- 0–360, compass bearing

  -- Conditions
  weather_code    smallint,           -- WMO weather interpretation code
  conditions      text,               -- Human label derived from WMO code

  -- Metadata
  is_forecast     boolean     NOT NULL DEFAULT false,
  source          text        NOT NULL DEFAULT 'open-meteo',
  fetched_at      timestamptz NOT NULL DEFAULT now(),

  UNIQUE (area, date)
);

CREATE INDEX IF NOT EXISTS weather_daily_area_date ON weather_daily (area, date);

COMMENT ON TABLE weather_daily IS
  'Daily weather per EMCC route area. Populated from Open-Meteo archive + forecast APIs.';
COMMENT ON COLUMN weather_daily.weather_code IS
  'WMO weather interpretation code (0=Clear, 61=Rain, 71=Snow, 95=Thunderstorm, etc.)';
COMMENT ON COLUMN weather_daily.is_forecast IS
  'true while the date is in the future; overwritten to false once the archive API covers that day.';
