-- =============================================================================
-- SmartStylist — 0012: controlled writer for the shared weather cache
--
-- Found in Phase 3. `weather_snapshots` is shared reference data written on the
-- request path, but granting INSERT to `authenticated` would let any client
-- poison the cache for everyone in that map cell (say, "it is 45°C in London").
--
-- Instead the API calls a SECURITY DEFINER function that validates the values
-- and is the only sanctioned write path. Clients still get SELECT.
-- =============================================================================

create or replace function public.upsert_weather_snapshot(
  p_geohash5     char(5),
  p_valid_at     timestamptz,
  p_provider     text,
  p_temp_c       numeric,
  p_feels_like_c numeric default null,
  p_temp_min_c   numeric default null,
  p_temp_max_c   numeric default null,
  p_humidity_pct smallint default null,
  p_wind_kph     numeric default null,
  p_precip_prob  numeric default null,
  p_uv_index     numeric default null,
  p_condition    text default null,
  p_is_daylight  boolean default null
) returns bigint
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id bigint;
begin
  if public.current_user_id() is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  if p_geohash5 !~ '^[0-9bcdefghjkmnpqrstuvwxyz]{5}$' then
    raise exception 'invalid geohash: %', p_geohash5 using errcode = '22023';
  end if;
  -- Reject physically impossible readings rather than caching them for others.
  if p_temp_c is null or p_temp_c < -90 or p_temp_c > 60 then
    raise exception 'temperature out of range: %', p_temp_c using errcode = '22023';
  end if;
  if p_precip_prob is not null and (p_precip_prob < 0 or p_precip_prob > 1) then
    raise exception 'precip_prob out of range' using errcode = '22023';
  end if;
  if p_valid_at > now() + interval '10 days' or p_valid_at < now() - interval '10 days' then
    raise exception 'valid_at is outside the usable forecast window' using errcode = '22023';
  end if;

  insert into public.weather_snapshots
      (geohash5, valid_at, provider, temp_c, feels_like_c, temp_min_c, temp_max_c,
       humidity_pct, wind_kph, precip_prob, uv_index, condition, is_daylight)
  values (p_geohash5, p_valid_at, p_provider, p_temp_c, p_feels_like_c, p_temp_min_c,
          p_temp_max_c, p_humidity_pct, p_wind_kph, p_precip_prob, p_uv_index,
          p_condition, p_is_daylight)
  on conflict (geohash5, valid_at, provider) do update
      set temp_c = excluded.temp_c,
          feels_like_c = excluded.feels_like_c,
          temp_min_c = excluded.temp_min_c,
          temp_max_c = excluded.temp_max_c,
          humidity_pct = excluded.humidity_pct,
          wind_kph = excluded.wind_kph,
          precip_prob = excluded.precip_prob,
          uv_index = excluded.uv_index,
          condition = excluded.condition,
          is_daylight = excluded.is_daylight,
          fetched_at = now()
  returning id into v_id;

  return v_id;
end;
$$;

revoke all on function public.upsert_weather_snapshot from public;
grant execute on function public.upsert_weather_snapshot to authenticated, service_role;
