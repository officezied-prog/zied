-- =============================================================================
-- SmartStylist — 0015: sanctioned access to body reference photos
--
-- `private.body_reference_photos` has no grants for clients — deliberately, it
-- is the most sensitive table in the system. Phase 4 needs the API to register,
-- list and delete them, so it gets three SECURITY DEFINER accessors that check
-- ownership and consent and write an audit row, exactly like the biometric
-- accessors in migration 0008.
-- =============================================================================

create or replace function public.register_body_photo(
  p_media_id uuid,
  p_pose text default 'front_full',
  p_is_primary boolean default true
) returns uuid
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_user uuid := public.current_user_id();
  v_id   uuid;
begin
  if v_user is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  if not public.has_consent(v_user, 'vton_processing') then
    raise exception 'vton_processing consent required' using errcode = '42501';
  end if;
  if not exists (select 1 from public.media_assets
                  where id = p_media_id and user_id = v_user and deleted_at is null) then
    raise exception 'media asset not found' using errcode = 'P0002';
  end if;
  if p_pose not in ('front_full','front_half','side','back','custom') then
    raise exception 'invalid pose: %', p_pose using errcode = '22023';
  end if;

  if p_is_primary then
    update private.body_reference_photos set is_primary = false where user_id = v_user;
  end if;

  insert into private.body_reference_photos
      (user_id, media_asset_id, pose, is_primary, consent_version, prep_status)
  values (v_user, p_media_id, p_pose, p_is_primary,
          (select policy_version from public.v_user_consent_state
            where user_id = v_user and consent_type = 'vton_processing'),
          'queued')
  returning id into v_id;

  insert into audit.access_log (actor_user_id, actor_role, subject_user_id, action,
                                object_type, object_id)
  values (v_user, current_user, v_user, 'register_body_photo', 'body_photo', v_id::text);

  return v_id;
end;
$$;

create or replace function public.list_body_photos()
returns table (
  id uuid, pose text, is_primary boolean, prep_status text,
  quality_score numeric, quality_issues text[], media_asset_id uuid,
  bucket text, storage_key text, created_at timestamptz
)
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_user uuid := public.current_user_id();
begin
  if v_user is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  return query
    select p.id, p.pose, p.is_primary, p.prep_status::text, p.quality_score,
           p.quality_issues, p.media_asset_id, m.bucket, m.storage_key, p.created_at
      from private.body_reference_photos p
      join public.media_assets m on m.id = p.media_asset_id
     where p.user_id = v_user
     order by p.is_primary desc, p.created_at desc;
end;
$$;

create or replace function public.delete_body_photo(p_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_user uuid := public.current_user_id();
  v_deleted int;
begin
  if v_user is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;

  -- Cancel any queued render that depends on it before the row disappears.
  update public.vton_jobs set status = 'cancelled', finished_at = now()
   where body_photo_id = p_id and user_id = v_user and status in ('queued','running');

  delete from private.body_reference_photos where id = p_id and user_id = v_user;
  get diagnostics v_deleted = row_count;

  insert into audit.access_log (actor_user_id, actor_role, subject_user_id, action,
                                object_type, object_id)
  values (v_user, current_user, v_user, 'delete_body_photo', 'body_photo', p_id::text);

  return v_deleted > 0;
end;
$$;

-- Revoking vton_processing must actually remove the photos, not just block use.
create or replace function public.purge_body_photos_on_revocation()
returns trigger
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
begin
  if new.consent_type = 'vton_processing' and new.granted = false then
    update public.vton_jobs set status = 'cancelled', finished_at = now()
     where user_id = new.user_id and status in ('queued','running');
    delete from private.body_reference_photos where user_id = new.user_id;

    insert into audit.access_log (actor_user_id, subject_user_id, action, object_type)
    values (new.user_id, new.user_id, 'purge_body_photos_on_revocation', 'body_photo');
  end if;
  return null;
end;
$$;

create trigger consent_revocation_purges_body_photos
  after insert on public.user_consents
  for each row execute function public.purge_body_photos_on_revocation();

revoke all on function public.register_body_photo(uuid, text, boolean) from public;
revoke all on function public.list_body_photos() from public;
revoke all on function public.delete_body_photo(uuid) from public;
grant execute on function public.register_body_photo(uuid, text, boolean)
   to authenticated, service_role;
grant execute on function public.list_body_photos() to authenticated, service_role;
grant execute on function public.delete_body_photo(uuid) to authenticated, service_role;
