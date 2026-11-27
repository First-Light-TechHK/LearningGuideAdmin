BEGIN;

-- 仅处理问答 JSON；Release 中的原始内容参与快照与卡片哈希。
CREATE FUNCTION pg_temp.clean_qa(card jsonb) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
  payload jsonb := card->'approvedPayload';
  language_key text;
  trigger_path text[];
  kept jsonb;
BEGIN
  IF card->>'type' IS DISTINCT FROM 'professor_qa'
     OR jsonb_typeof(payload) IS DISTINCT FROM 'object'
     OR NOT (payload ?| ARRAY['variants','keywords']) THEN
    RETURN card;
  END IF;
  IF jsonb_typeof(payload->'variants') = 'array' THEN
    FOREACH language_key IN ARRAY ARRAY['en','zh'] LOOP
      trigger_path := ARRAY['bilingual','triggers',language_key];
      IF jsonb_typeof(card #> trigger_path) = 'array' THEN
        SELECT coalesce(jsonb_agg(term ORDER BY n), '[]'::jsonb) INTO kept
        FROM jsonb_array_elements(card #> trigger_path) WITH ORDINALITY t(term,n)
        WHERE term = payload->'question' OR NOT (payload->'variants' @> jsonb_build_array(term));
        card := jsonb_set(card, trigger_path, kept);
      END IF;
    END LOOP;
  END IF;
  RETURN jsonb_set(card, '{approvedPayload}', payload - 'variants' - 'keywords');
END;
$$;

UPDATE "TutorTeachingCard"
SET draft = pg_temp.clean_qa(draft), approved = pg_temp.clean_qa(approved)
WHERE (draft->>'type' = 'professor_qa' AND draft->'approvedPayload' ?| ARRAY['variants','keywords'])
   OR (approved->>'type' = 'professor_qa' AND approved->'approvedPayload' ?| ARRAY['variants','keywords']);

-- 老版本的其他卡片及未使用额外问法的索引可以原样复用。
CREATE TEMP TABLE qa_reindex ON COMMIT DROP AS
SELECT r.id AS release_id, card->>'cardId' AS card_id
FROM "Release" r
CROSS JOIN LATERAL jsonb_array_elements(
  CASE WHEN jsonb_typeof(r."snapshotData" #> '{teachingPackage,cards}') = 'array'
    THEN r."snapshotData" #> '{teachingPackage,cards}' ELSE '[]'::jsonb END
) card
WHERE card->>'type' = 'professor_qa'
  AND jsonb_typeof(card #> '{approvedPayload,variants}') = 'array'
  AND card #> '{approvedPayload,variants}' <> '[]'::jsonb;

UPDATE "ProfessorQaIndex" SET "activeGeneration" = NULL, lease = NULL, "nextAttempt" = now()
WHERE "releaseId" IN (SELECT release_id FROM qa_reindex);
DELETE FROM "ProfessorQaPart" p USING qa_reindex q
WHERE p."releaseId" = q.release_id AND p."cardId" = q.card_id;

COMMIT;
