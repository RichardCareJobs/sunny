-- Export the venues for one city as the pipeline's data/<city>/venues.json.
-- Run in the Supabase SQL editor (or via MCP) and save the json_agg value.
-- Only names, the city/district label and enrichment signals are exported;
-- no Google coordinates.
select json_agg(v order by v.place_id) from (
  select d.place_id, d.name, d.city,
    (select bool_or(a.value) from venue_attributes a
      where a.place_id = d.place_id and a.attribute = 'rooftop_seating' and a.status <> 'rejected') as rooftop_attr,
    (select bool_or(a.value) from venue_attributes a
      where a.place_id = d.place_id and a.attribute = 'outdoor_seating' and a.status <> 'rejected') as outdoor_attr,
    (select json_object_agg(t->>'title', (t->>'capped')::int)
       from venue_enrichment e,
            jsonb_array_elements(case when jsonb_typeof(e.outdoor_evidence_tags) = 'array'
                                      then e.outdoor_evidence_tags else '[]' end) t
      where e.place_id = d.place_id) as tags
  from venue_details d
  where d.city ilike 'dublin%' or d.city in ('Kimmage', 'Barracks')   -- see cities/dublin.json venue_city_match
) v;

-- Existing seating rows (so manual/venue points are reused, never overwritten):
-- select json_agg(s) from venue_seating s where city = 'Dublin';
