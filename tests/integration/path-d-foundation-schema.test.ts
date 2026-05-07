/**
 * A3a — Path D Foundation Schema Integration Tests
 *
 * Validates migration 093's 5 new tables (target_field_coverage,
 * project_decisions, project_lookup_tables, project_data_quality_issues,
 * project_inferred_targets) plus the 5 TFM enrichment columns
 * (transformation_intent, mapping_cardinality, dedup_required,
 * dedup_strategy, data_quality_flag_ids).
 *
 * Coverage per table:
 *   - happy-path INSERT + SELECT (admin client)
 *   - CHECK / NOT NULL constraint denials (where applicable)
 *   - UNIQUE denials (target_field_coverage, project_lookup_tables)
 *   - FK CASCADE on parent project deletion
 *   - updated_at trigger advance (tables 1–3 only)
 *   - RLS denial (viewer-role user attempts INSERT, expects failure)
 *   - FK SET NULL on auth.users deletion (tables 1, 2, 4 — auth-attribution columns)
 *
 * Plus TFM enrichment column coverage:
 *   - heritage proof: existing canary TFM rows show NULL/FALSE/[] defaults
 *   - forward proof: new TFM row insert with all 5 new columns set
 *   - CHECK denial on mapping_cardinality
 *
 * Env-gated via RUN_PATH_D_FOUNDATION_INTEGRATION=1. Fixture pattern mirrors
 * tests/integration/project-rbac-strict-membership.test.ts: fresh org +
 * editor + viewer user + 2 projects (main fixture + cascade-test) + 1 TFM
 * seed row, all torn down in afterAll.
 *
 * Required env (mirrors RBAC test):
 *   NEXT_PUBLIC_SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *   NEXT_PUBLIC_SUPABASE_ANON_KEY
 *   HERITAGE_PROJECT_ID                — for the TFM heritage-proof block
 *   RUN_PATH_D_FOUNDATION_INTEGRATION=1
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const RUN = process.env.RUN_PATH_D_FOUNDATION_INTEGRATION === "1";

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const HERITAGE_PROJECT_ID = process.env.HERITAGE_PROJECT_ID ?? "";

const ENV_OK = Boolean(URL) && Boolean(SERVICE_KEY) && Boolean(ANON_KEY);

const describeIf = RUN && ENV_OK ? describe : describe.skip;

// ─────────────────────────────────────────────────────────────────────
// State shared across all tests in the suite. Populated in beforeAll,
// cleaned up in afterAll. Per-test resources (e.g. an extra coverage row
// to verify trigger advance) are created inside their `it()` blocks and
// either rely on CASCADE cleanup or are deleted inline.
// ─────────────────────────────────────────────────────────────────────

type State = {
  password: string;
  stamp: string;
  orgId: string;
  editorEmail: string;
  editorUserId: string;
  viewerEmail: string;
  viewerUserId: string;
  mainProjectId: string;
  cascadeProjectId: string;
  datasetId: string;
  tableId: string;
  targetFieldId: string;
  tfmId: string;
};

const STATE: Partial<State> = {};

describeIf("A3a — Path D Foundation Schema (migration 093)", () => {
  let supabaseAdmin!: SupabaseClient;

  // ───────────────────────────────────────────────────────────────────
  // Helper: sign in as a specific test user. Returns an anon-key client
  // carrying a JWT with `sub` = user.id so RLS evaluates against the
  // user's project_members row, not the service role.
  // ───────────────────────────────────────────────────────────────────
  async function signInAs(email: string): Promise<SupabaseClient> {
    const client = createClient(URL!, ANON_KEY!, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { error } = await client.auth.signInWithPassword({
      email,
      password: STATE.password!,
    });
    if (error) throw new Error(`signIn failed for ${email}: ${error.message}`);
    return client;
  }

  beforeAll(async () => {
    if (!RUN) return;
    if (!ENV_OK) {
      throw new Error(
        "A3a integration requires NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY + NEXT_PUBLIC_SUPABASE_ANON_KEY",
      );
    }

    supabaseAdmin = createClient(URL!, SERVICE_KEY!);

    STATE.password = `Test-${Math.random().toString(36).slice(2, 12)}!Aa1`;
    STATE.stamp = `${Date.now()}`;
    STATE.editorEmail = `path-d-editor-${STATE.stamp}@settle-test.local`;
    STATE.viewerEmail = `path-d-viewer-${STATE.stamp}@settle-test.local`;

    // Org (slug NOT NULL UNIQUE per migration 050)
    const { data: org, error: orgErr } = await supabaseAdmin
      .from("organizations")
      .insert({ name: `A3a Org ${STATE.stamp}`, slug: `a3a-${STATE.stamp}` })
      .select("id")
      .single();
    if (orgErr) throw orgErr;
    STATE.orgId = org!.id;

    // Users
    const createUser = async (email: string) => {
      const { data, error } = await supabaseAdmin.auth.admin.createUser({
        email,
        password: STATE.password!,
        email_confirm: true,
      });
      if (error) throw error;
      return data.user!.id;
    };
    STATE.editorUserId = await createUser(STATE.editorEmail!);
    STATE.viewerUserId = await createUser(STATE.viewerEmail!);

    // Org memberships (both users in the same org so they have org-level access)
    await supabaseAdmin.from("org_memberships").insert([
      { org_id: STATE.orgId, user_id: STATE.editorUserId, role: "member" },
      { org_id: STATE.orgId, user_id: STATE.viewerUserId, role: "member" },
    ]);

    // Disable member_auto_grant so we control project_members rows manually
    await supabaseAdmin
      .from("organizations")
      .update({ member_auto_grant_enabled: false })
      .eq("id", STATE.orgId);

    // Projects: main fixture + cascade-test
    const createProject = async (name: string) => {
      const { data, error } = await supabaseAdmin
        .from("projects")
        .insert({
          name,
          org_id: STATE.orgId,
          user_id: STATE.editorUserId,
          created_by: STATE.editorUserId,
          use_mapping_redesign: true,
        })
        .select("id")
        .single();
      if (error) throw error;

      // Grant access via the canonical RPC (mirrors createProject fanout)
      await supabaseAdmin.rpc("grant_new_project_access", {
        p_project_id: data!.id,
        p_org_id: STATE.orgId,
        p_creator_id: STATE.editorUserId,
      });

      return data!.id as string;
    };
    STATE.mainProjectId = await createProject(`A3a Main ${STATE.stamp}`);
    STATE.cascadeProjectId = await createProject(`A3a Cascade ${STATE.stamp}`);

    // Project members: editor at 'editor', viewer at 'viewer' on both projects
    await supabaseAdmin.from("project_members").insert([
      {
        project_id: STATE.mainProjectId,
        user_id: STATE.editorUserId,
        role: "editor",
        assigned_by: STATE.editorUserId,
      },
      {
        project_id: STATE.mainProjectId,
        user_id: STATE.viewerUserId,
        role: "viewer",
        assigned_by: STATE.editorUserId,
      },
      {
        project_id: STATE.cascadeProjectId,
        user_id: STATE.editorUserId,
        role: "editor",
        assigned_by: STATE.editorUserId,
      },
      {
        project_id: STATE.cascadeProjectId,
        user_id: STATE.viewerUserId,
        role: "viewer",
        assigned_by: STATE.editorUserId,
      },
    ]);

    // Seed: 1 dataset + 1 table + 1 target field + 1 TFM row in main fixture
    const { data: dataset, error: dsErr } = await supabaseAdmin
      .from("datasets")
      .insert({
        project_id: STATE.mainProjectId,
        role: "target",
        name: "A3a target dataset",
      })
      .select("id")
      .single();
    if (dsErr) throw dsErr;
    STATE.datasetId = dataset!.id;

    const { data: table, error: tblErr } = await supabaseAdmin
      .from("tables")
      .insert({
        dataset_id: STATE.datasetId,
        name: "a3a_target_table",
      })
      .select("id")
      .single();
    if (tblErr) throw tblErr;
    STATE.tableId = table!.id;

    const { data: field, error: fldErr } = await supabaseAdmin
      .from("fields")
      .insert({
        table_id: STATE.tableId,
        name: "a3a_target_field",
        data_type: "TEXT",
        ordinal_position: 1,
      })
      .select("id")
      .single();
    if (fldErr) throw fldErr;
    STATE.targetFieldId = field!.id;

    const { data: tfm, error: tfmErr } = await supabaseAdmin
      .from("target_field_mappings")
      .insert({
        project_id: STATE.mainProjectId,
        target_field_id: STATE.targetFieldId,
        status: "needs_review",
        combination_type: "single",
      })
      .select("id")
      .single();
    if (tfmErr) throw tfmErr;
    STATE.tfmId = tfm!.id;
  }, 30_000);

  afterAll(async () => {
    if (!RUN || !ENV_OK || !supabaseAdmin) return;

    // Order: cascade-test project first (may already be deleted by the
    // CASCADE test); main project second; org third; users last.
    if (STATE.cascadeProjectId) {
      await supabaseAdmin
        .from("projects")
        .delete()
        .eq("id", STATE.cascadeProjectId);
    }
    if (STATE.mainProjectId) {
      await supabaseAdmin
        .from("projects")
        .delete()
        .eq("id", STATE.mainProjectId);
    }
    if (STATE.orgId) {
      await supabaseAdmin.from("organizations").delete().eq("id", STATE.orgId);
    }
    if (STATE.editorUserId) {
      await supabaseAdmin.auth.admin
        .deleteUser(STATE.editorUserId)
        .catch(() => {});
    }
    if (STATE.viewerUserId) {
      await supabaseAdmin.auth.admin
        .deleteUser(STATE.viewerUserId)
        .catch(() => {});
    }
  }, 30_000);

  // ═══════════════════════════════════════════════════════════════════
  // 1. target_field_coverage
  // ═══════════════════════════════════════════════════════════════════

  describe("target_field_coverage", () => {
    it("inserts and reads back a happy-path row", async () => {
      const { data, error } = await supabaseAdmin
        .from("target_field_coverage")
        .insert({
          project_id: STATE.mainProjectId,
          target_field_id: STATE.targetFieldId,
          coverage_status: "covered",
          ai_reasoning: "Direct PK mapping.",
          default_value_recommendation: { strategy: "none" },
        })
        .select("id, coverage_status, ai_reasoning, created_at, updated_at")
        .single();
      expect(error).toBeNull();
      expect(data?.coverage_status).toBe("covered");
      expect(data?.ai_reasoning).toBe("Direct PK mapping.");
      expect(data?.created_at).toBeTruthy();
      expect(data?.updated_at).toBeTruthy();

      // Cleanup so the UNIQUE test below has a clean slot
      await supabaseAdmin
        .from("target_field_coverage")
        .delete()
        .eq("id", data!.id);
    });

    it("rejects invalid coverage_status via CHECK constraint", async () => {
      const { error } = await supabaseAdmin
        .from("target_field_coverage")
        .insert({
          project_id: STATE.mainProjectId,
          target_field_id: STATE.targetFieldId,
          coverage_status: "not_a_real_status",
        });
      expect(error).toBeTruthy();
      expect(error?.code).toBe("23514");
    });

    it("rejects duplicate (project_id, target_field_id) via UNIQUE", async () => {
      const first = await supabaseAdmin
        .from("target_field_coverage")
        .insert({
          project_id: STATE.mainProjectId,
          target_field_id: STATE.targetFieldId,
          coverage_status: "partial",
        })
        .select("id")
        .single();
      expect(first.error).toBeNull();

      const dup = await supabaseAdmin.from("target_field_coverage").insert({
        project_id: STATE.mainProjectId,
        target_field_id: STATE.targetFieldId,
        coverage_status: "gap",
      });
      expect(dup.error).toBeTruthy();
      expect(dup.error?.code).toBe("23505");

      await supabaseAdmin
        .from("target_field_coverage")
        .delete()
        .eq("id", first.data!.id);
    });

    it("cascades on parent project delete", async () => {
      // Insert a dataset + field + coverage row inside cascade-test project
      const { data: ds } = await supabaseAdmin
        .from("datasets")
        .insert({
          project_id: STATE.cascadeProjectId,
          role: "target",
          name: "cascade ds",
        })
        .select("id")
        .single();
      const { data: tbl } = await supabaseAdmin
        .from("tables")
        .insert({ dataset_id: ds!.id, name: "cascade_tbl" })
        .select("id")
        .single();
      const { data: fld } = await supabaseAdmin
        .from("fields")
        .insert({
          table_id: tbl!.id,
          name: "cascade_fld",
          data_type: "TEXT",
          ordinal_position: 1,
        })
        .select("id")
        .single();
      const { data: cov } = await supabaseAdmin
        .from("target_field_coverage")
        .insert({
          project_id: STATE.cascadeProjectId,
          target_field_id: fld!.id,
          coverage_status: "gap",
        })
        .select("id")
        .single();
      expect(cov?.id).toBeTruthy();

      // Delete parent project — CASCADE chain should remove the coverage row
      const del = await supabaseAdmin
        .from("projects")
        .delete()
        .eq("id", STATE.cascadeProjectId);
      expect(del.error).toBeNull();

      // Verify
      const { data: orphan } = await supabaseAdmin
        .from("target_field_coverage")
        .select("id")
        .eq("id", cov!.id)
        .maybeSingle();
      expect(orphan).toBeNull();

      // Re-create cascade project for any downstream tests that need it
      const { data: recreated } = await supabaseAdmin
        .from("projects")
        .insert({
          name: `A3a Cascade Recreated ${STATE.stamp}`,
          org_id: STATE.orgId,
          user_id: STATE.editorUserId,
          created_by: STATE.editorUserId,
          use_mapping_redesign: true,
        })
        .select("id")
        .single();
      STATE.cascadeProjectId = recreated!.id;
      await supabaseAdmin.rpc("grant_new_project_access", {
        p_project_id: STATE.cascadeProjectId,
        p_org_id: STATE.orgId,
        p_creator_id: STATE.editorUserId,
      });
    });

    it("updates updated_at on row UPDATE via trigger", async () => {
      const { data: ins } = await supabaseAdmin
        .from("target_field_coverage")
        .upsert(
          {
            project_id: STATE.mainProjectId,
            target_field_id: STATE.targetFieldId,
            coverage_status: "partial",
          },
          { onConflict: "project_id,target_field_id" },
        )
        .select("id, updated_at")
        .single();
      const initialUpdatedAt = ins!.updated_at as string;
      expect(initialUpdatedAt).toBeTruthy();

      await new Promise((r) => setTimeout(r, 100));

      const { data: upd } = await supabaseAdmin
        .from("target_field_coverage")
        .update({ coverage_status: "covered" })
        .eq("id", ins!.id)
        .select("updated_at")
        .single();
      const newUpdatedAt = upd!.updated_at as string;

      expect(new Date(newUpdatedAt).getTime()).toBeGreaterThan(
        new Date(initialUpdatedAt).getTime(),
      );

      await supabaseAdmin
        .from("target_field_coverage")
        .delete()
        .eq("id", ins!.id);
    });

    it("denies INSERT to viewer-role user via RLS", async () => {
      const client = await signInAs(STATE.viewerEmail!);
      const { error } = await client.from("target_field_coverage").insert({
        project_id: STATE.mainProjectId,
        target_field_id: STATE.targetFieldId,
        coverage_status: "covered",
      });
      expect(error).toBeTruthy();
    });

    it("preserves attribution as NULL when default_decided_by user is deleted (FK SET NULL)", async () => {
      // Create a temporary auth user (no project membership needed for FK)
      const tempEmail = `path-d-temp-cov-${Date.now()}@settle-test.local`;
      const { data: tempU } = await supabaseAdmin.auth.admin.createUser({
        email: tempEmail,
        password: STATE.password!,
        email_confirm: true,
      });
      const tempUserId = tempU!.user!.id;

      const { data: cov } = await supabaseAdmin
        .from("target_field_coverage")
        .insert({
          project_id: STATE.mainProjectId,
          target_field_id: STATE.targetFieldId,
          coverage_status: "covered",
          default_decided_by: tempUserId,
          default_decided_at: new Date().toISOString(),
        })
        .select("id, default_decided_by")
        .single();
      expect(cov?.default_decided_by).toBe(tempUserId);

      await supabaseAdmin.auth.admin.deleteUser(tempUserId);

      const { data: after } = await supabaseAdmin
        .from("target_field_coverage")
        .select("default_decided_by")
        .eq("id", cov!.id)
        .single();
      expect(after?.default_decided_by).toBeNull();

      await supabaseAdmin
        .from("target_field_coverage")
        .delete()
        .eq("id", cov!.id);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 2. project_decisions
  // ═══════════════════════════════════════════════════════════════════

  describe("project_decisions", () => {
    it("inserts and reads back a happy-path row", async () => {
      const { data, error } = await supabaseAdmin
        .from("project_decisions")
        .insert({
          project_id: STATE.mainProjectId,
          decision_type: "picklist_transform",
          title: "Map Status enum to single-char target",
          ai_recommendation: {
            option: "A",
            value: "Active",
            rationale: "Most common.",
          },
          alternatives: [{ option: "B", value: "A" }],
          status: "pending",
        })
        .select("id, status, ai_recommendation, alternatives")
        .single();
      expect(error).toBeNull();
      expect(data?.status).toBe("pending");
      expect((data?.ai_recommendation as { value: string }).value).toBe(
        "Active",
      );

      await supabaseAdmin.from("project_decisions").delete().eq("id", data!.id);
    });

    it("rejects invalid status via CHECK constraint", async () => {
      const { error } = await supabaseAdmin.from("project_decisions").insert({
        project_id: STATE.mainProjectId,
        decision_type: "whatever",
        title: "x",
        ai_recommendation: {},
        alternatives: [],
        status: "somewhere_in_between",
      });
      expect(error).toBeTruthy();
      expect(error?.code).toBe("23514");
    });

    it("cascades on parent project delete", async () => {
      const { data: dec } = await supabaseAdmin
        .from("project_decisions")
        .insert({
          project_id: STATE.cascadeProjectId,
          decision_type: "picklist_transform",
          title: "cascade decision",
          ai_recommendation: {},
          alternatives: [],
          status: "pending",
        })
        .select("id")
        .single();
      expect(dec?.id).toBeTruthy();

      await supabaseAdmin
        .from("projects")
        .delete()
        .eq("id", STATE.cascadeProjectId);

      const { data: orphan } = await supabaseAdmin
        .from("project_decisions")
        .select("id")
        .eq("id", dec!.id)
        .maybeSingle();
      expect(orphan).toBeNull();

      // Recreate cascade project
      const { data: recreated } = await supabaseAdmin
        .from("projects")
        .insert({
          name: `A3a Cascade Recreated decisions ${STATE.stamp}`,
          org_id: STATE.orgId,
          user_id: STATE.editorUserId,
          created_by: STATE.editorUserId,
          use_mapping_redesign: true,
        })
        .select("id")
        .single();
      STATE.cascadeProjectId = recreated!.id;
      await supabaseAdmin.rpc("grant_new_project_access", {
        p_project_id: STATE.cascadeProjectId,
        p_org_id: STATE.orgId,
        p_creator_id: STATE.editorUserId,
      });
    });

    it("updates updated_at on row UPDATE via trigger", async () => {
      const { data: ins } = await supabaseAdmin
        .from("project_decisions")
        .insert({
          project_id: STATE.mainProjectId,
          decision_type: "picklist_transform",
          title: "trigger test",
          ai_recommendation: {},
          alternatives: [],
          status: "pending",
        })
        .select("id, updated_at")
        .single();
      const initial = ins!.updated_at as string;

      await new Promise((r) => setTimeout(r, 100));

      const { data: upd } = await supabaseAdmin
        .from("project_decisions")
        .update({ status: "decided", decided_at: new Date().toISOString() })
        .eq("id", ins!.id)
        .select("updated_at")
        .single();
      const after = upd!.updated_at as string;

      expect(new Date(after).getTime()).toBeGreaterThan(
        new Date(initial).getTime(),
      );

      await supabaseAdmin.from("project_decisions").delete().eq("id", ins!.id);
    });

    it("denies INSERT to viewer-role user via RLS", async () => {
      const client = await signInAs(STATE.viewerEmail!);
      const { error } = await client.from("project_decisions").insert({
        project_id: STATE.mainProjectId,
        decision_type: "picklist_transform",
        title: "viewer attempt",
        ai_recommendation: {},
        alternatives: [],
        status: "pending",
      });
      expect(error).toBeTruthy();
    });

    it("preserves attribution as NULL when decided_by user is deleted (FK SET NULL)", async () => {
      const tempEmail = `path-d-temp-dec-${Date.now()}@settle-test.local`;
      const { data: tempU } = await supabaseAdmin.auth.admin.createUser({
        email: tempEmail,
        password: STATE.password!,
        email_confirm: true,
      });
      const tempUserId = tempU!.user!.id;

      const { data: dec } = await supabaseAdmin
        .from("project_decisions")
        .insert({
          project_id: STATE.mainProjectId,
          decision_type: "picklist_transform",
          title: "set-null test",
          ai_recommendation: {},
          alternatives: [],
          status: "decided",
          decided_at: new Date().toISOString(),
          decided_by: tempUserId,
        })
        .select("id, decided_by")
        .single();
      expect(dec?.decided_by).toBe(tempUserId);

      await supabaseAdmin.auth.admin.deleteUser(tempUserId);

      const { data: after } = await supabaseAdmin
        .from("project_decisions")
        .select("decided_by")
        .eq("id", dec!.id)
        .single();
      expect(after?.decided_by).toBeNull();

      await supabaseAdmin.from("project_decisions").delete().eq("id", dec!.id);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 3. project_lookup_tables
  // ═══════════════════════════════════════════════════════════════════

  describe("project_lookup_tables", () => {
    it("inserts and reads back a happy-path row", async () => {
      const { data, error } = await supabaseAdmin
        .from("project_lookup_tables")
        .insert({
          project_id: STATE.mainProjectId,
          name: `uom_norm_${Date.now()}`,
          description: "Unit-of-measure normalization",
          mappings: { Each: "EA", Lbs: "LB" },
        })
        .select("id, name, mappings, customer_approved")
        .single();
      expect(error).toBeNull();
      expect((data?.mappings as { Each: string }).Each).toBe("EA");
      expect(data?.customer_approved).toBe(false);

      await supabaseAdmin
        .from("project_lookup_tables")
        .delete()
        .eq("id", data!.id);
    });

    it("rejects duplicate (project_id, name) via UNIQUE", async () => {
      const sharedName = `dup_lookup_${Date.now()}`;
      const first = await supabaseAdmin
        .from("project_lookup_tables")
        .insert({
          project_id: STATE.mainProjectId,
          name: sharedName,
          mappings: {},
        })
        .select("id")
        .single();
      expect(first.error).toBeNull();

      const dup = await supabaseAdmin.from("project_lookup_tables").insert({
        project_id: STATE.mainProjectId,
        name: sharedName,
        mappings: {},
      });
      expect(dup.error).toBeTruthy();
      expect(dup.error?.code).toBe("23505");

      await supabaseAdmin
        .from("project_lookup_tables")
        .delete()
        .eq("id", first.data!.id);
    });

    it("cascades on parent project delete", async () => {
      const { data: lk } = await supabaseAdmin
        .from("project_lookup_tables")
        .insert({
          project_id: STATE.cascadeProjectId,
          name: `cascade_lookup_${Date.now()}`,
          mappings: { x: "y" },
        })
        .select("id")
        .single();
      expect(lk?.id).toBeTruthy();

      await supabaseAdmin
        .from("projects")
        .delete()
        .eq("id", STATE.cascadeProjectId);

      const { data: orphan } = await supabaseAdmin
        .from("project_lookup_tables")
        .select("id")
        .eq("id", lk!.id)
        .maybeSingle();
      expect(orphan).toBeNull();

      const { data: recreated } = await supabaseAdmin
        .from("projects")
        .insert({
          name: `A3a Cascade Recreated lookups ${STATE.stamp}`,
          org_id: STATE.orgId,
          user_id: STATE.editorUserId,
          created_by: STATE.editorUserId,
          use_mapping_redesign: true,
        })
        .select("id")
        .single();
      STATE.cascadeProjectId = recreated!.id;
      await supabaseAdmin.rpc("grant_new_project_access", {
        p_project_id: STATE.cascadeProjectId,
        p_org_id: STATE.orgId,
        p_creator_id: STATE.editorUserId,
      });
    });

    it("updates updated_at on row UPDATE via trigger", async () => {
      const { data: ins } = await supabaseAdmin
        .from("project_lookup_tables")
        .insert({
          project_id: STATE.mainProjectId,
          name: `trigger_lookup_${Date.now()}`,
          mappings: {},
        })
        .select("id, updated_at")
        .single();
      const initial = ins!.updated_at as string;

      await new Promise((r) => setTimeout(r, 100));

      const { data: upd } = await supabaseAdmin
        .from("project_lookup_tables")
        .update({ customer_approved: true })
        .eq("id", ins!.id)
        .select("updated_at")
        .single();
      const after = upd!.updated_at as string;

      expect(new Date(after).getTime()).toBeGreaterThan(
        new Date(initial).getTime(),
      );

      await supabaseAdmin
        .from("project_lookup_tables")
        .delete()
        .eq("id", ins!.id);
    });

    it("denies INSERT to viewer-role user via RLS", async () => {
      const client = await signInAs(STATE.viewerEmail!);
      const { error } = await client.from("project_lookup_tables").insert({
        project_id: STATE.mainProjectId,
        name: `viewer_lookup_${Date.now()}`,
        mappings: {},
      });
      expect(error).toBeTruthy();
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 4. project_data_quality_issues
  // ═══════════════════════════════════════════════════════════════════

  describe("project_data_quality_issues", () => {
    it("inserts and reads back a happy-path row", async () => {
      const { data, error } = await supabaseAdmin
        .from("project_data_quality_issues")
        .insert({
          project_id: STATE.mainProjectId,
          severity: "warning",
          category: "inconsistent_format",
          description: "Mixed phone formats across rows.",
          example_values: ["(555) 123-4567", "5551234567"],
        })
        .select("id, severity, category, example_values")
        .single();
      expect(error).toBeNull();
      expect(data?.severity).toBe("warning");
      expect(Array.isArray(data?.example_values)).toBe(true);

      await supabaseAdmin
        .from("project_data_quality_issues")
        .delete()
        .eq("id", data!.id);
    });

    it("rejects invalid severity via CHECK constraint", async () => {
      const { error } = await supabaseAdmin
        .from("project_data_quality_issues")
        .insert({
          project_id: STATE.mainProjectId,
          severity: "apocalyptic",
          category: "cat",
          description: "d",
        });
      expect(error).toBeTruthy();
      expect(error?.code).toBe("23514");
    });

    it("cascades on parent project delete", async () => {
      const { data: iss } = await supabaseAdmin
        .from("project_data_quality_issues")
        .insert({
          project_id: STATE.cascadeProjectId,
          severity: "info",
          category: "cascade_test",
          description: "cascade",
        })
        .select("id")
        .single();
      expect(iss?.id).toBeTruthy();

      await supabaseAdmin
        .from("projects")
        .delete()
        .eq("id", STATE.cascadeProjectId);

      const { data: orphan } = await supabaseAdmin
        .from("project_data_quality_issues")
        .select("id")
        .eq("id", iss!.id)
        .maybeSingle();
      expect(orphan).toBeNull();

      const { data: recreated } = await supabaseAdmin
        .from("projects")
        .insert({
          name: `A3a Cascade Recreated dq ${STATE.stamp}`,
          org_id: STATE.orgId,
          user_id: STATE.editorUserId,
          created_by: STATE.editorUserId,
          use_mapping_redesign: true,
        })
        .select("id")
        .single();
      STATE.cascadeProjectId = recreated!.id;
      await supabaseAdmin.rpc("grant_new_project_access", {
        p_project_id: STATE.cascadeProjectId,
        p_org_id: STATE.orgId,
        p_creator_id: STATE.editorUserId,
      });
    });

    it("denies INSERT to viewer-role user via RLS", async () => {
      const client = await signInAs(STATE.viewerEmail!);
      const { error } = await client
        .from("project_data_quality_issues")
        .insert({
          project_id: STATE.mainProjectId,
          severity: "info",
          category: "rls_test",
          description: "viewer attempt",
        });
      expect(error).toBeTruthy();
    });

    it("preserves attribution as NULL when acknowledged_by user is deleted (FK SET NULL)", async () => {
      const tempEmail = `path-d-temp-dq-${Date.now()}@settle-test.local`;
      const { data: tempU } = await supabaseAdmin.auth.admin.createUser({
        email: tempEmail,
        password: STATE.password!,
        email_confirm: true,
      });
      const tempUserId = tempU!.user!.id;

      const { data: iss } = await supabaseAdmin
        .from("project_data_quality_issues")
        .insert({
          project_id: STATE.mainProjectId,
          severity: "info",
          category: "set_null_test",
          description: "set-null",
          acknowledged_at: new Date().toISOString(),
          acknowledged_by: tempUserId,
        })
        .select("id, acknowledged_by")
        .single();
      expect(iss?.acknowledged_by).toBe(tempUserId);

      await supabaseAdmin.auth.admin.deleteUser(tempUserId);

      const { data: after } = await supabaseAdmin
        .from("project_data_quality_issues")
        .select("acknowledged_by")
        .eq("id", iss!.id)
        .single();
      expect(after?.acknowledged_by).toBeNull();

      await supabaseAdmin
        .from("project_data_quality_issues")
        .delete()
        .eq("id", iss!.id);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 5. project_inferred_targets
  // ═══════════════════════════════════════════════════════════════════

  describe("project_inferred_targets", () => {
    it("inserts and reads back a happy-path row", async () => {
      const { data, error } = await supabaseAdmin
        .from("project_inferred_targets")
        .insert({
          project_id: STATE.mainProjectId,
          inferred_target_object: "Contact",
          evidence_source_fields: [STATE.targetFieldId],
          reasoning:
            "Source has contact_first / contact_last columns suggesting a Contact entity.",
        })
        .select("id, inferred_target_object, evidence_source_fields")
        .single();
      expect(error).toBeNull();
      expect(data?.inferred_target_object).toBe("Contact");
      expect(Array.isArray(data?.evidence_source_fields)).toBe(true);

      await supabaseAdmin
        .from("project_inferred_targets")
        .delete()
        .eq("id", data!.id);
    });

    it("rejects NULL inferred_target_object via NOT NULL", async () => {
      const { error } = await supabaseAdmin
        .from("project_inferred_targets")
        .insert({
          project_id: STATE.mainProjectId,
          inferred_target_object: null as unknown as string,
          reasoning: "missing object name",
        });
      expect(error).toBeTruthy();
      expect(error?.code).toBe("23502");
    });

    it("cascades on parent project delete", async () => {
      const { data: inf } = await supabaseAdmin
        .from("project_inferred_targets")
        .insert({
          project_id: STATE.cascadeProjectId,
          inferred_target_object: "CascadeContact",
        })
        .select("id")
        .single();
      expect(inf?.id).toBeTruthy();

      await supabaseAdmin
        .from("projects")
        .delete()
        .eq("id", STATE.cascadeProjectId);

      const { data: orphan } = await supabaseAdmin
        .from("project_inferred_targets")
        .select("id")
        .eq("id", inf!.id)
        .maybeSingle();
      expect(orphan).toBeNull();

      const { data: recreated } = await supabaseAdmin
        .from("projects")
        .insert({
          name: `A3a Cascade Recreated inferred ${STATE.stamp}`,
          org_id: STATE.orgId,
          user_id: STATE.editorUserId,
          created_by: STATE.editorUserId,
          use_mapping_redesign: true,
        })
        .select("id")
        .single();
      STATE.cascadeProjectId = recreated!.id;
      await supabaseAdmin.rpc("grant_new_project_access", {
        p_project_id: STATE.cascadeProjectId,
        p_org_id: STATE.orgId,
        p_creator_id: STATE.editorUserId,
      });
    });

    it("denies INSERT to viewer-role user via RLS", async () => {
      const client = await signInAs(STATE.viewerEmail!);
      const { error } = await client.from("project_inferred_targets").insert({
        project_id: STATE.mainProjectId,
        inferred_target_object: "ViewerAttempt",
      });
      expect(error).toBeTruthy();
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 6. target_field_mappings — enrichment columns
  // ═══════════════════════════════════════════════════════════════════

  describe("target_field_mappings enrichment columns", () => {
    it("heritage proof: existing canary TFM rows show NULL/FALSE/[] defaults for the 5 new columns", async () => {
      if (!HERITAGE_PROJECT_ID) {
        // Skip-with-message rather than fail when the canary env is absent.
        // Suite is otherwise complete; this single check requires the canary.
        console.warn(
          "[A3a] HERITAGE_PROJECT_ID unset — skipping heritage proof block",
        );
        return;
      }
      const { data, error } = await supabaseAdmin
        .from("target_field_mappings")
        .select(
          "id, transformation_intent, mapping_cardinality, dedup_required, dedup_strategy, data_quality_flag_ids",
        )
        .eq("project_id", HERITAGE_PROJECT_ID)
        .limit(20);
      expect(error).toBeNull();
      expect(data && data.length).toBeGreaterThan(0);
      for (const row of data!) {
        expect(row.transformation_intent).toBeNull();
        expect(row.mapping_cardinality).toBeNull();
        expect(row.dedup_required).toBe(false);
        expect(row.dedup_strategy).toBeNull();
        expect(Array.isArray(row.data_quality_flag_ids)).toBe(true);
        expect((row.data_quality_flag_ids as unknown[]).length).toBe(0);
      }
    });

    it("forward proof: insert TFM with all 5 new columns and round-trip via SELECT", async () => {
      // Need a fresh target field so we don't conflict with the seeded TFM
      const { data: fld } = await supabaseAdmin
        .from("fields")
        .insert({
          table_id: STATE.tableId,
          name: `a3a_enrich_field_${Date.now()}`,
          data_type: "TEXT",
          ordinal_position: 2,
        })
        .select("id")
        .single();

      const { data, error } = await supabaseAdmin
        .from("target_field_mappings")
        .insert({
          project_id: STATE.mainProjectId,
          target_field_id: fld!.id,
          status: "needs_review",
          combination_type: "single",
          transformation_intent: "Concatenate first + last with space.",
          mapping_cardinality: "many_to_one",
          dedup_required: true,
          dedup_strategy: { keys: ["email"], conflict: "latest_wins" },
          data_quality_flag_ids: ["11111111-1111-1111-1111-111111111111"],
        })
        .select(
          "id, transformation_intent, mapping_cardinality, dedup_required, dedup_strategy, data_quality_flag_ids",
        )
        .single();
      expect(error).toBeNull();
      expect(data?.transformation_intent).toBe(
        "Concatenate first + last with space.",
      );
      expect(data?.mapping_cardinality).toBe("many_to_one");
      expect(data?.dedup_required).toBe(true);
      expect((data?.dedup_strategy as { conflict: string }).conflict).toBe(
        "latest_wins",
      );
      expect((data?.data_quality_flag_ids as string[])[0]).toBe(
        "11111111-1111-1111-1111-111111111111",
      );

      await supabaseAdmin
        .from("target_field_mappings")
        .delete()
        .eq("id", data!.id);
      await supabaseAdmin.from("fields").delete().eq("id", fld!.id);
    });

    it("rejects invalid mapping_cardinality via CHECK", async () => {
      const { data: fld } = await supabaseAdmin
        .from("fields")
        .insert({
          table_id: STATE.tableId,
          name: `a3a_check_field_${Date.now()}`,
          data_type: "TEXT",
          ordinal_position: 3,
        })
        .select("id")
        .single();

      const { error } = await supabaseAdmin
        .from("target_field_mappings")
        .insert({
          project_id: STATE.mainProjectId,
          target_field_id: fld!.id,
          status: "needs_review",
          combination_type: "single",
          mapping_cardinality: "not_a_real_cardinality",
        });
      expect(error).toBeTruthy();
      expect(error?.code).toBe("23514");

      await supabaseAdmin.from("fields").delete().eq("id", fld!.id);
    });
  });
});
