import { useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { boRequest } from "../lib/api";

type VideoAsset = { id: string } | null;
type Loc = { language: string; title: string; description: string | null; textHtml: string | null; video: VideoAsset; videoDurationSeconds: number | null };
type Exhibit = { id: string; code: string; type: string; media: { id: string } | null; thumbnail: { id: string } | null; localized: Record<string, { title?: string; description?: string }> };
type Reading = { type: string; title: string; author: string | null; whyRecommended: string | null };
type Question = { code: string; question: string; referenceAnswer: string | null };
type Lesson = { id: string; code: string; sortOrder: number; localizations: Loc[]; exhibits: Exhibit[]; readings: Reading[]; questions: Question[]; applicationTest: { scenario: string; referenceAnswer: string | null } | null };
type CourseLoc = { language: string; title: string; shortDescription: string | null; overview: string | null; whatYouLearn: unknown; provides: unknown };
type Course = { id: string; code: string; slug: string; learningMode: string; learningLanguages: string[]; defaultContentLanguage: string; subtitle: string | null; lifecycleStatus: string; liveStatus: string; category?: { name?: string } | null; localizations: CourseLoc[]; lessons: Lesson[]; cover: { id: string } | null };

const L = (locale: string, zh: string, en: string) => (locale.startsWith("zh") ? zh : en);
const esc = (v: unknown): string[] => Array.isArray(v) ? v.map((x) => typeof x === "string" ? x : (x && (x as { title?: string }).title) || "").filter(Boolean) : [];
function fmtTotal(sec: number, locale: string): string {
  if (!sec) return "";
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  if (locale.startsWith("zh")) return h > 0 ? `${h}小时${m}分钟` : `${m}分钟`;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}
function fmtMMSS(sec: number | null): string {
  if (!sec) return "";
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function CoursePreviewPage() {
  const { courseId = "", locale = "en-GB" } = useParams();
  const [course, setCourse] = useState<Course | null>(null);
  const [error, setError] = useState("");
  const [activeLesson, setActiveLesson] = useState("");

  useEffect(() => {
    boRequest<Course>("/api/backoffice/courses/" + courseId).then((r) => {
      if (r.success) { setCourse(r.data); setActiveLesson(r.data.lessons[0]?.id || ""); }
      else setError(L(locale, "加载失败：", "Load failed: ") + r.error);
    });
  }, [courseId, locale]);

  if (error) return <section className="card cardGrow"><p>{error}</p></section>;
  if (!course) return <section className="card cardGrow"><p>{L(locale, "加载中…", "Loading…")}</p></section>;

  const lang = course.defaultContentLanguage;
  const loc = course.localizations.find((l) => l.language === lang) || course.localizations[0];
  const lesson = course.lessons.find((l) => l.id === activeLesson);
  const lloc = lesson && (lesson.localizations.find((l) => l.language === lang) || lesson.localizations[0]);
  const mediaUrl = (assetId: string) => "/api/backoffice/courses/" + courseId + "/media/" + assetId;
  const coverUrl = "/api/backoffice/courses/" + courseId + "/cover";
  const totalSec = course.lessons.reduce((a, l) => a + ((l.localizations.find((x) => x.language === lang) || l.localizations[0])?.videoDurationSeconds || 0), 0);
  const lessonNo = (l: Lesson) => l.sortOrder;

  return (
    <section className="card cardGrow" style={{ overflow: "auto", maxWidth: 1080, margin: "0 auto", padding: "24px 32px" }}>
      <nav style={{ fontSize: 13, opacity: 0.65, marginBottom: 16 }}>
        <Link to={"/" + locale + "/course"}>{L(locale, "← 返回编辑", "← Back to editor")}</Link>
        <span style={{ margin: "0 6px" }}>·</span>
        <span>{L(locale, "学员视角预览（工作副本）", "Learner view preview (working copy)")}</span>
      </nav>

      {course.cover && <img src={coverUrl} alt="cover" style={{ width: "100%", maxHeight: 320, objectFit: "cover", borderRadius: 16 }} />}

      {course.category?.name && (
        <div style={{ marginTop: 20 }}>
          <span style={{ background: "#EEF3FF", color: "#2B58C8", borderRadius: 999, padding: "2px 10px", fontSize: 12 }}>{course.category.name}</span>
        </div>
      )}
      <h1 style={{ margin: "12px 0 8px", fontSize: 30 }}>{loc?.title}</h1>
      {loc?.shortDescription && <p style={{ fontSize: 16, opacity: 0.8, margin: 0 }}>{loc.shortDescription}</p>}
      <div style={{ marginTop: 10, opacity: 0.7, fontSize: 14 }}>
        {course.lessons.length} {L(locale, "节课", "lessons")}{totalSec ? ` · ${fmtTotal(totalSec, locale)}` : ""} · {course.learningMode}
      </div>

      {loc?.overview && (
        <div style={{ marginTop: 28 }}>
          <h2 style={{ fontSize: 20 }}>{L(locale, "课程概览", "Overview")}</h2>
          <p style={{ whiteSpace: "pre-wrap", lineHeight: 1.7 }}>{loc.overview}</p>
        </div>
      )}

      {esc(loc?.whatYouLearn).length > 0 && (
        <div style={{ marginTop: 24 }}>
          <h2 style={{ fontSize: 20 }}>{L(locale, "你将学到什么", "What you'll learn")}</h2>
          <ul style={{ lineHeight: 1.9 }}>{esc(loc?.whatYouLearn).map((t, i) => <li key={i}>{t}</li>)}</ul>
        </div>
      )}

      <div style={{ marginTop: 28, borderTop: "1px solid #E8EDF5", paddingTop: 20 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
          <h2 style={{ fontSize: 20, margin: 0 }}>{L(locale, "课程大纲", "Course outline")}</h2>
          <span style={{ opacity: 0.7, fontSize: 14 }}>{course.lessons.length} {L(locale, "节课", "lessons")}{totalSec ? ` · ${fmtTotal(totalSec, locale)}` : ""}</span>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 10, marginTop: 14 }}>
          {[...course.lessons].sort((a, b) => a.sortOrder - b.sortOrder).map((l) => {
            const t = l.localizations.find((x) => x.language === lang) || l.localizations[0];
            const active = l.id === activeLesson;
            return (
              <button key={l.id} onClick={() => setActiveLesson(l.id)} style={{ textAlign: "left", padding: "14px 16px", borderRadius: 12, border: active ? "1px solid #2B58C8" : "1px solid #E8EDF5", background: active ? "#F5F8FF" : "#fff", cursor: "pointer" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
                  <strong>{L(locale, "课时", "Lesson")} {lessonNo(l)}　{t?.title}</strong>
                  <span style={{ opacity: 0.7, fontSize: 13 }}>{fmtMMSS(t?.videoDurationSeconds ?? null)}</span>
                </div>
                {t?.description && <div style={{ opacity: 0.75, fontSize: 14, marginTop: 4 }}>{t.description}</div>}
              </button>
            );
          })}
        </div>
      </div>

      {esc(loc?.provides).length > 0 && (
        <div style={{ marginTop: 28 }}>
          <h2 style={{ fontSize: 20 }}>{L(locale, "本课程提供", "This course provides")}</h2>
          <ul style={{ lineHeight: 1.9 }}>{esc(loc?.provides).map((t, i) => <li key={i}>{t}</li>)}</ul>
        </div>
      )}

      {lesson && (
        <div style={{ marginTop: 32, borderTop: "1px solid #E8EDF5", paddingTop: 24 }}>
          <h2 style={{ fontSize: 22 }}>{L(locale, "课时", "Lesson")} {lessonNo(lesson)}　{lloc?.title}</h2>
          {lloc?.video && (
            <video controls style={{ width: "100%", maxHeight: 460, background: "#000", borderRadius: 10, marginTop: 12 }} src={mediaUrl(lloc.video.id)} />
          )}
          {lloc?.textHtml && (
            <div style={{ marginTop: 16, lineHeight: 1.8 }} dangerouslySetInnerHTML={{ __html: lloc.textHtml }} />
          )}
          {lesson.exhibits.length > 0 && (
            <div style={{ marginTop: 20 }}>
              <h3>{L(locale, "展品", "Exhibits")}</h3>
              <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
                {lesson.exhibits.map((ex) => {
                  const el = ex.localized[lang] || Object.values(ex.localized)[0] || {};
                  return (
                    <figure key={ex.id} style={{ width: 260, margin: 0 }}>
                      {ex.media && <img src={mediaUrl(ex.media.id)} alt={el.title || ex.code} style={{ width: "100%", borderRadius: 10 }} />}
                      <figcaption style={{ fontSize: 13, marginTop: 6 }}><strong>{el.title || ex.code}</strong>{el.description ? " — " + el.description : ""}</figcaption>
                    </figure>
                  );
                })}
              </div>
            </div>
          )}
          {lesson.readings.length > 0 && (
            <div style={{ marginTop: 20 }}><h3>{L(locale, "推荐阅读", "Recommended reading")}</h3><ul>{lesson.readings.map((r, i) => <li key={i}>{r.title}{r.author ? " — " + r.author : ""}</li>)}</ul></div>
          )}
          {lesson.questions.length > 0 && (
            <div style={{ marginTop: 20 }}><h3>{L(locale, "知识测试", "Knowledge test")}（{lesson.questions.length}）</h3><ol>{lesson.questions.map((q) => <li key={q.code} style={{ marginBottom: 8 }}>{q.question}</li>)}</ol></div>
          )}
          {lesson.applicationTest && (
            <div style={{ marginTop: 20 }}><h3>{L(locale, "应用测试", "Application test")}</h3><p style={{ whiteSpace: "pre-wrap" }}>{lesson.applicationTest.scenario}</p></div>
          )}
        </div>
      )}
    </section>
  );
}
