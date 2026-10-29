import { useCallback, useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { boRequest } from "../lib/api";

interface LessonLoc { language: string; title: string; description: string | null; textHtml: string | null; video: { id: string } | null; videoDurationSeconds: number | null }
interface Lesson { id: string; code: string; sortOrder: number; localizations: LessonLoc[]; exhibits: unknown[]; questions: unknown[]; readings: unknown[]; applicationTest: unknown | null }
interface CourseLoc { language: string; title: string; shortDescription: string | null; overview: string | null; whatYouLearn: unknown; provides: unknown }
interface CourseDetail {
  id: string; code: string; slug: string; learningMode: string; learningLanguages: string[]; defaultContentLanguage: string;
  subtitle: string | null; level: string | null; lifecycleStatus: string; liveStatus: string;
  category?: { name?: string } | null; cover?: { id: string } | null;
  localizations: CourseLoc[]; lessons: Lesson[];
}

const inputStyle: React.CSSProperties = { width: "100%", padding: 10, border: "1px solid #d9e0ea", borderRadius: 8, boxSizing: "border-box", fontSize: 14 };
const labelStyle: React.CSSProperties = { display: "block", fontWeight: 600, margin: "14px 0 6px", color: "#25314C", fontSize: 13 };
const buttonStyle: React.CSSProperties = { padding: "8px 14px", border: "1px solid #d9e0ea", borderRadius: 8, background: "#fff", cursor: "pointer", fontSize: 14 };
const primaryBtn: React.CSSProperties = { ...buttonStyle, background: "#2B58C8", color: "#fff", border: "1px solid #2B58C8" };
const card: React.CSSProperties = { border: "1px solid #E8EDF5", borderRadius: 14, padding: 20, background: "#fff", marginTop: 18 };
const L = (locale: string, zh: string, en: string) => (locale.startsWith("zh") ? zh : en);
const Chip = ({ children, tone = "grey" }: { children: React.ReactNode; tone?: "grey" | "green" | "amber" }) => (
  <span style={{ fontSize: 12, padding: "2px 10px", borderRadius: 999, background: tone === "green" ? "#E7F6EC" : tone === "amber" ? "#FFF6E5" : "#EEF1F6", color: tone === "green" ? "#1E7A3C" : tone === "amber" ? "#9A6B00" : "#5A6577" }}>{children}</span>
);

export function CourseEditorPage() {
  const { courseId = "", locale = "en-GB" } = useParams();
  const navigate = useNavigate();
  const [course, setCourse] = useState<CourseDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [activeLessonId, setActiveLessonId] = useState("");
  const [tab, setTab] = useState<"info" | "content">("content");

  const load = useCallback(async () => {
    setLoading(true);
    const result = await boRequest<CourseDetail>(`/api/backoffice/courses/${courseId}`);
    setLoading(false);
    if (result.success) { setCourse(result.data); if (!activeLessonId && result.data.lessons[0]) setActiveLessonId(result.data.lessons[0].id); }
    else setNotice(`Could not load course: ${result.error}`);
  }, [courseId, activeLessonId]);
  useEffect(() => { void load(); }, [load]);

  const language = course?.defaultContentLanguage ?? "en-GB";
  const localization = course?.localizations.find((i) => i.language === language) ?? course?.localizations[0];
  const activeLesson = course?.lessons.find((l) => l.id === activeLessonId);
  const lloc = activeLesson?.localizations.find((i) => i.language === language) ?? activeLesson?.localizations[0];

  async function saveCourse(form: FormData) {
    if (!course) return;
    setBusy(true);
    const core = await boRequest(`/api/backoffice/courses/${course.id}`, {
      method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: String(form.get("code")), slug: String(form.get("slug")), learningMode: String(form.get("learningMode")), defaultContentLanguage: language, learningLanguages: course.learningLanguages, subtitle: String(form.get("subtitle") ?? "") || null, level: String(form.get("level") ?? "") || null }),
    });
    const loc = await boRequest(`/api/backoffice/courses/${course.id}/localizations/${encodeURIComponent(language)}`, {
      method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: String(form.get("title")), shortDescription: String(form.get("shortDescription") ?? "") || null, overview: String(form.get("overview") ?? "") || null, whatYouLearn: String(form.get("whatYouLearn") ?? "").split("\n").map((x) => x.trim()).filter(Boolean), provides: String(form.get("provides") ?? "").split("\n").map((x) => x.trim()).filter(Boolean).map((title) => ({ type: "custom", title })) }),
    });
    setBusy(false);
    if (core.success && loc.success) { setNotice(L(locale, "课程信息已保存。", "Course information saved.")); await load(); }
    else setNotice(`Save failed: ${core.success ? loc.error : core.error}`);
  }

  async function addLesson() {
    if (!course) return;
    const title = window.prompt(L(locale, "课时标题", "Lesson title"))?.trim();
    if (!title) return;
    setBusy(true);
    const result = await boRequest<CourseDetail>(`/api/backoffice/courses/${course.id}/lessons`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title, language }) });
    setBusy(false);
    if (result.success) { setCourse(result.data); const newest = [...result.data.lessons].sort((a, b) => b.sortOrder - a.sortOrder)[0]; setActiveLessonId(newest?.id ?? ""); setNotice(L(locale, "课时已添加。", "Lesson added.")); }
    else setNotice(`Could not add lesson: ${result.error}`);
  }

  async function saveLesson(form: FormData) {
    if (!course || !activeLesson) return;
    setBusy(true);
    const result = await boRequest<CourseDetail>(`/api/backoffice/courses/${course.id}/lessons/${activeLesson.id}`, {
      method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ language, code: String(form.get("lessonCode")), title: String(form.get("lessonTitle")), description: String(form.get("lessonDescription") ?? "") || null, textHtml: String(form.get("lessonText") ?? "") || null }),
    });
    setBusy(false);
    if (result.success) { setCourse(result.data); setNotice(L(locale, "课时已保存。", "Lesson saved.")); }
    else setNotice(`Lesson save failed: ${result.error}`);
  }

  async function importDocx(file: File) {
    const form = new FormData(); form.append("file", file);
    setBusy(true);
    const result = await boRequest<{ title: string; markdown: string }>("/api/files/convert", { method: "POST", body: form });
    setBusy(false);
    if (result.success) {
      const area = document.querySelector<HTMLTextAreaElement>('[name="lessonText"]');
      if (area) { area.value = result.data.markdown; area.dispatchEvent(new Event("input", { bubbles: true })); }
      const title = document.querySelector<HTMLInputElement>('[name="lessonTitle"]');
      if (title && !title.value) title.value = result.data.title;
      setNotice(L(locale, "已从文件导入文本，请检查后保存。", `Imported text from ${file.name}. Review it and save.`));
    } else setNotice(`Word conversion failed: ${result.error}`);
  }

  async function moveLesson(direction: -1 | 1) {
    if (!course || !activeLesson) return;
    const ordered = [...course.lessons].sort((a, b) => a.sortOrder - b.sortOrder);
    const index = ordered.findIndex((l) => l.id === activeLesson.id);
    const nextIndex = index + direction;
    if (index < 0 || nextIndex < 0 || nextIndex >= ordered.length) return;
    [ordered[index], ordered[nextIndex]] = [ordered[nextIndex], ordered[index]];
    setBusy(true);
    const result = await boRequest<CourseDetail>(`/api/backoffice/courses/${course.id}/lessons/reorder`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ lessonIds: ordered.map((l) => l.id) }) });
    setBusy(false);
    if (result.success) { setCourse(result.data); setNotice(L(locale, "课时顺序已保存。", "Lesson order saved.")); }
    else setNotice(`Reorder failed: ${result.error}`);
  }

  async function deleteLesson() {
    if (!course || !activeLesson || !window.confirm(L(locale, "确认删除该课时？", `Delete ${lloc?.title ?? activeLesson.code}?`))) return;
    setBusy(true);
    const result = await boRequest<CourseDetail>(`/api/backoffice/courses/${course.id}/lessons/${activeLesson.id}`, { method: "DELETE" });
    setBusy(false);
    if (result.success) { setCourse(result.data); setActiveLessonId(result.data.lessons[0]?.id ?? ""); setNotice(L(locale, "课时已删除。", "Lesson deleted.")); }
    else setNotice(`Delete failed: ${result.error}`);
  }

  if (loading) return <section className="card cardGrow"><p>{L(locale, "加载课程中…", "Loading course…")}</p></section>;
  if (!course) return <section className="card cardGrow"><p>{notice}</p></section>;

  const coverUrl = `/api/backoffice/courses/${courseId}/cover`;
  const lessonNo = (l: Lesson) => l.sortOrder;

  return <section className="card cardGrow" style={{ overflow: "auto" }}>
    <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 16, borderBottom: "1px solid #E8EDF5", paddingBottom: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
        <button style={buttonStyle} onClick={() => navigate(`/${locale}/course`)}>←</button>
        {course.cover ? <img src={coverUrl} alt="cover" style={{ width: 72, height: 48, objectFit: "cover", borderRadius: 8, border: "1px solid #E8EDF5" }} /> : <div style={{ width: 72, height: 48, borderRadius: 8, background: "#EEF1F6" }} />}
        <div>
          <h1 style={{ margin: 0, fontSize: 22 }}>{localization?.title ?? course.slug}</h1>
          <div style={{ display: "flex", gap: 8, marginTop: 6, alignItems: "center" }}>
            <Chip>{course.code}</Chip>
            {course.category?.name && <Chip>{course.category.name}</Chip>}
            <Chip tone="amber">{course.lifecycleStatus}</Chip>
            <Chip tone={course.liveStatus === "ONLINE" ? "green" : "grey"}>{course.liveStatus}</Chip>
          </div>
        </div>
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <button style={buttonStyle} onClick={() => void load()}>{L(locale, "重新加载", "Reload")}</button>
        <button style={primaryBtn} onClick={() => window.open(`/${locale}/course/${courseId}/preview`, "_blank")}>{L(locale, "学员视角预览", "Preview (learner view)")}</button>
      </div>
    </header>

    {notice && <p role="status" style={{ padding: 10, background: "#F3F7FF", borderRadius: 8, marginTop: 14 }}>{notice}</p>}

    <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
      <button onClick={() => setTab("info")} style={{ ...buttonStyle, borderColor: tab === "info" ? "#2B58C8" : "#d9e0ea", color: tab === "info" ? "#2B58C8" : "#25314C", fontWeight: 600 }}>{L(locale, "课程信息", "Course Information")}</button>
      <button onClick={() => setTab("content")} style={{ ...buttonStyle, borderColor: tab === "content" ? "#2B58C8" : "#d9e0ea", color: tab === "content" ? "#2B58C8" : "#25314C", fontWeight: 600 }}>{L(locale, "课程内容", "Course Content")}</button>
    </div>
    {tab === "info" && (
      <form action={(form) => void saveCourse(form)}>
        <div style={card}>
          <h2 style={{ marginTop: 0, fontSize: 18 }}>{L(locale, "课程信息", "Course Information")}</h2>
          {course.cover && <img src={coverUrl} alt="cover" style={{ width: "100%", maxHeight: 220, objectFit: "cover", borderRadius: 10, border: "1px solid #E8EDF5", marginBottom: 8 }} />}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0 16px" }}>
            <label style={labelStyle}>{L(locale, "课程标题", "Course title")}<input name="title" required defaultValue={localization?.title ?? ""} style={inputStyle} /></label>
            <label style={labelStyle}>{L(locale, "课程代码", "Course code")}<input name="code" required defaultValue={course.code} style={inputStyle} /></label>
            <label style={labelStyle}>Slug<input name="slug" required defaultValue={course.slug} style={inputStyle} /></label>
            <label style={labelStyle}>{L(locale, "学习模式", "Learning mode")}<select name="learningMode" defaultValue={course.learningMode} style={inputStyle}><option value="VIDEO_AND_TEXT">{L(locale, "视频 + 文本", "Video and text")}</option><option value="VIDEO_ONLY">{L(locale, "仅视频", "Video only")}</option><option value="TEXT_ONLY">{L(locale, "仅文本", "Text only")}</option></select></label>
            <label style={labelStyle}>{L(locale, "副标题", "Subtitle")}<input name="subtitle" defaultValue={course.subtitle ?? ""} style={inputStyle} /></label>
            <label style={labelStyle}>{L(locale, "简短描述", "Short description")}<input name="shortDescription" defaultValue={localization?.shortDescription ?? ""} style={inputStyle} /></label>
          </div>
          <label style={labelStyle}>{L(locale, "课程概览", "Overview")}<textarea name="overview" rows={4} defaultValue={localization?.overview ?? ""} style={inputStyle} /></label>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
            <label style={labelStyle}>{L(locale, "你将学到什么（每行一条）", "What you'll learn (one per line)")}<textarea name="whatYouLearn" rows={5} defaultValue={Array.isArray(localization?.whatYouLearn) ? localization.whatYouLearn.join("\n") : ""} style={inputStyle} /></label>
            <label style={labelStyle}>{L(locale, "本课程提供（每行一条）", "This course provides (one per line)")}<textarea name="provides" rows={5} defaultValue={Array.isArray(localization?.provides) ? (localization!.provides as unknown[]).map((x) => (typeof x === "string" ? x : (x && (x as { title?: string }).title) || "")).filter(Boolean).join("\n") : ""} style={inputStyle} /></label>
          </div>
          <div style={{ marginTop: 16 }}><button type="submit" disabled={busy} style={primaryBtn}>{L(locale, "保存课程信息", "Save course information")}</button></div>
        </div>
      </form>
    )}

    {tab === "content" && (
      <div style={{ display: "grid", gridTemplateColumns: "minmax(200px, 280px) 1fr", gap: 20, marginTop: 18 }}>
        <aside style={{ ...card, marginTop: 0, padding: 14 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
            <h3 style={{ margin: 0, fontSize: 15 }}>{L(locale, "课时", "Lessons")}</h3>
            <button type="button" style={buttonStyle} disabled={busy} onClick={() => void addLesson()}>{L(locale, "+ 添加", "+ Add")}</button>
          </div>
          {course.lessons.length === 0 && <p style={{ opacity: 0.7 }}>{L(locale, "暂无课时。", "No lessons yet.")}</p>}
          {[...course.lessons].sort((a, b) => a.sortOrder - b.sortOrder).map((l) => (
            <button key={l.id} type="button" onClick={() => setActiveLessonId(l.id)} style={{ ...buttonStyle, display: "block", width: "100%", textAlign: "left", marginBottom: 6, borderColor: activeLessonId === l.id ? "#2B58C8" : "#E8EDF5", background: activeLessonId === l.id ? "#F5F8FF" : "#fff" }}>{lessonNo(l)}. {l.localizations.find((x) => x.language === language)?.title ?? l.code}</button>
          ))}
        </aside>

        {activeLesson && (
          <form key={activeLesson.id} action={(form) => void saveLesson(form)} style={{ ...card, marginTop: 0 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <h3 style={{ margin: 0, fontSize: 16 }}>{L(locale, "课时编辑", "Lesson editor")} · {L(locale, "课时", "Lesson")} {lessonNo(activeLesson)}</h3>
              <div style={{ display: "flex", gap: 6 }}>
                <button type="button" style={buttonStyle} disabled={busy} onClick={() => void moveLesson(-1)}>↑</button>
                <button type="button" style={buttonStyle} disabled={busy} onClick={() => void moveLesson(1)}>↓</button>
                <button type="button" style={{ ...buttonStyle, color: "#b42318" }} disabled={busy} onClick={() => void deleteLesson()}>{L(locale, "删除", "Delete")}</button>
              </div>
            </div>

            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 10 }}>
              <Chip tone={lloc?.video ? "green" : "grey"}>{L(locale, "视频", "Video")}{lloc?.video ? " ✓" : " —"}</Chip>
              {lloc?.videoDurationSeconds ? <Chip>{Math.floor(lloc.videoDurationSeconds / 60)}:{String(Math.round(lloc.videoDurationSeconds % 60)).padStart(2, "0")}</Chip> : null}
              <Chip>{L(locale, "展品", "Exhibits")} {activeLesson.exhibits.length}</Chip>
              <Chip>{L(locale, "知识测试", "Knowledge")} {activeLesson.questions.length}</Chip>
              <Chip>{L(locale, "阅读", "Reading")} {activeLesson.readings.length}</Chip>
              <Chip tone={activeLesson.applicationTest ? "green" : "grey"}>{L(locale, "应用测试", "Application")}{activeLesson.applicationTest ? " ✓" : " —"}</Chip>
            </div>
            <p style={{ fontSize: 12, opacity: 0.6, marginTop: 8 }}>{L(locale, "视频 / 展品 / 测试 / 阅读内容来自导入的课程包，此处只读；可编辑标题、描述与正文。", "Video / exhibits / tests / reading come from the imported package and are read-only here; title, description and text are editable.")}</p>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0 16px" }}>
              <label style={labelStyle}>{L(locale, "课时代码", "Lesson code")}<input name="lessonCode" defaultValue={activeLesson.code} style={inputStyle} /></label>
              <label style={labelStyle}>{L(locale, "课时标题", "Lesson title")}<input name="lessonTitle" required defaultValue={lloc?.title ?? ""} style={inputStyle} /></label>
            </div>
            <label style={labelStyle}>{L(locale, "描述", "Description")}<textarea name="lessonDescription" rows={2} defaultValue={lloc?.description ?? ""} style={inputStyle} /></label>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 14 }}>
              <label style={{ ...labelStyle, margin: 0 }}>{L(locale, "学习与探索 · 文本（Markdown）", "Study & Exploration · Text (Markdown)")}<input type="file" accept=".docx,.doc,.md,.txt,.pdf" disabled={busy} onChange={(e) => { const f = e.target.files?.[0]; if (f) void importDocx(f); e.currentTarget.value = ""; }} /></label>
              <small style={{ opacity: 0.6 }}>{L(locale, "导入 Word / 文本", "Import Word / text")}</small>
            </div>
            <textarea name="lessonText" rows={18} defaultValue={lloc?.textHtml ?? ""} style={{ ...inputStyle, marginTop: 10, fontFamily: "monospace" }} />
            <div style={{ marginTop: 12 }}><button type="submit" disabled={busy} style={primaryBtn}>{L(locale, "保存课时", "Save lesson")}</button></div>
          </form>
        )}
      </div>
    )}
  </section>;
}
