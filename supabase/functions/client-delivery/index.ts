import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Cache-Control": "no-store",
};

const BUCKET = "fbi-client-files";
const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";

function getSecretKey() {
  const modern = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (modern) {
    try {
      const parsed = JSON.parse(modern);
      if (parsed?.default) return parsed.default;
      const first = Object.values(parsed).find((v) => typeof v === "string");
      if (typeof first === "string") return first;
    } catch (_) {
      // Fall back to legacy secret below.
    }
  }
  return Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
}

const serviceKey = getSecretKey();
const admin = supabaseUrl && serviceKey
  ? createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    })
  : null;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json; charset=utf-8" },
  });
}

function validToken(v: string | null) {
  return !!v && /^[a-f0-9]{32,64}$/i.test(v);
}

function validUuid(v: string | null) {
  return !!v && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "GET") return json({ ok: false, error: "Method not allowed" }, 405);
  if (!admin) return json({ ok: false, error: "Delivery service is not configured" }, 500);

  const u = new URL(req.url);
  const action = u.searchParams.get("action") || "metadata";

  if (action === "health") return json({ ok: true, service: "fbi-client-file-studio" });

  const token = u.searchParams.get("token");
  const fileId = u.searchParams.get("file");
  if (!validToken(token)) return json({ ok: false, error: "Invalid share token" }, 400);

  const { data: project, error: projectError } = await admin
    .from("file_studio_projects")
    .select("id,name,client_name,delivery_note,shared,share_expires_at")
    .eq("share_token", token)
    .eq("shared", true)
    .maybeSingle();

  if (projectError) return json({ ok: false, error: projectError.message }, 500);
  if (!project) return json({ ok: false, error: "This delivery link is invalid or disabled." }, 404);

  if (project.share_expires_at && new Date(project.share_expires_at).getTime() < Date.now()) {
    return json({ ok: false, error: "This delivery link has expired." }, 410);
  }

  if (action === "metadata") {
    const { data: files, error: filesError } = await admin
      .from("file_studio_files")
      .select("id,file_name,mime_type,file_size,created_at")
      .eq("project_id", project.id)
      .order("created_at", { ascending: true });
    if (filesError) return json({ ok: false, error: filesError.message }, 500);
    return json({
      ok: true,
      project: {
        id: project.id,
        name: project.name,
        client_name: project.client_name,
        delivery_note: project.delivery_note,
        share_expires_at: project.share_expires_at,
      },
      files: files ?? [],
    });
  }

  if (action !== "download" && action !== "preview") {
    return json({ ok: false, error: "Unsupported action" }, 400);
  }
  if (!validUuid(fileId)) return json({ ok: false, error: "Invalid file id" }, 400);

  const { data: file, error: fileError } = await admin
    .from("file_studio_files")
    .select("id,file_name,storage_path,mime_type,file_size,project_id")
    .eq("id", fileId)
    .eq("project_id", project.id)
    .maybeSingle();

  if (fileError) return json({ ok: false, error: fileError.message }, 500);
  if (!file) return json({ ok: false, error: "File not found" }, 404);

  const expiresIn = action === "download" ? 900 : 300;
  const options = action === "download" ? { download: true } : undefined;
  const { data: signed, error: signError } = await admin.storage
    .from(BUCKET)
    .createSignedUrl(file.storage_path, expiresIn, options);

  if (signError) return json({ ok: false, error: signError.message }, 500);

  if (action === "download") {
    const { error: logError } = await admin.from("file_studio_downloads").insert({
      project_id: project.id,
      file_id: file.id,
    });
    if (logError) console.warn("Download event was not recorded", logError.message);
  }

  return json({ ok: true, url: signed.signedUrl, expires_in: expiresIn });
});