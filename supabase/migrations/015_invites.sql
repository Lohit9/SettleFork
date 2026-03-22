-- ============================================================
-- 015: Invite codes + access requests
-- Run this in the Supabase SQL editor
-- ============================================================

CREATE TABLE invites (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code        VARCHAR(20) UNIQUE NOT NULL,
  email       VARCHAR(255),
  name        VARCHAR(255),
  company     VARCHAR(255),
  status      TEXT DEFAULT 'pending'
                CHECK (status IN ('pending', 'used', 'expired')),
  created_by  UUID REFERENCES auth.users(id),
  used_by     UUID REFERENCES auth.users(id),
  created_at  TIMESTAMPTZ DEFAULT now(),
  used_at     TIMESTAMPTZ,
  expires_at  TIMESTAMPTZ DEFAULT (now() + interval '30 days')
);

ALTER TABLE invites ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can validate invite codes" ON invites
  FOR SELECT USING (true);

CREATE POLICY "Admin manages invites" ON invites
  FOR ALL USING (
    auth.uid() IN (
      SELECT id FROM auth.users
      WHERE email = 'kaandincer1@gmail.com'
    )
  );

-- ─────────────────────────────────────────────────────────────

CREATE TABLE access_requests (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name             VARCHAR(255) NOT NULL,
  email            VARCHAR(255) NOT NULL,
  company          VARCHAR(255) NOT NULL,
  role_type        VARCHAR(100) NOT NULL,
  systems_involved TEXT,
  additional_notes TEXT,
  status           TEXT DEFAULT 'new'
                     CHECK (status IN ('new', 'contacted', 'approved', 'declined')),
  created_at       TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE access_requests ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can submit access request" ON access_requests
  FOR INSERT WITH CHECK (true);

CREATE POLICY "Admin reads access requests" ON access_requests
  FOR ALL USING (
    auth.uid() IN (
      SELECT id FROM auth.users
      WHERE email = 'kaandincer1@gmail.com'
    )
  );
