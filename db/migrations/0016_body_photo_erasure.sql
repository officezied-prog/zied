-- =============================================================================
-- SmartStylist — 0016: make render erasure explicit
--
-- Found in Phase 4. `vton_jobs.body_photo_id` cascades, so deleting a body photo
-- already removed the jobs — but silently, and *only* the rows: the rendered
-- images stayed in object storage with nothing left pointing at them.
--
-- A try-on render is a picture of the user's body. Deleting the source photo, or
-- withdrawing vton_processing consent, must erase the renders too. The cascade
-- is now deliberate and complete: derived media is soft-deleted first (so the
-- retention worker deletes the bytes), then the jobs cascade away.
-- =============================================================================

create or replace function private.mark_renders_for_purge(p_user_id uuid, p_photo_id uuid)
returns int
language sql
security definer
set search_path = public, private, pg_temp
as $$
  with targets as (
    select j.result_media_id, j.preview_media_id
      from public.vton_jobs j
     where j.user_id = p_user_id
       and (p_photo_id is null or j.body_photo_id = p_photo_id)
  ),
  ids as (
    select result_media_id as id from targets where result_media_id is not null
    union
    select preview_media_id from targets where preview_media_id is not null
  ),
  purged as (
    update public.media_assets m
       set deleted_at = now()
      from ids
     where m.id = ids.id and m.deleted_at is null
    returning 1
  )
  select count(*)::int from purged;
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
  v_renders int;
begin
  if v_user is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;

  -- Renders derived from this photo are erased with it: they are pictures of
  -- the same body. Soft-delete marks the bytes for the retention worker; the
  -- job rows then cascade away with the photo.
  v_renders := private.mark_renders_for_purge(v_user, p_id);

  delete from private.body_reference_photos where id = p_id and user_id = v_user;
  get diagnostics v_deleted = row_count;

  insert into audit.access_log (actor_user_id, actor_role, subject_user_id, action,
                                object_type, object_id, details)
  values (v_user, current_user, v_user, 'delete_body_photo', 'body_photo', p_id::text,
          jsonb_build_object('renders_purged', v_renders));

  return v_deleted > 0;
end;
$$;

create or replace function public.purge_body_photos_on_revocation()
returns trigger
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_renders int;
begin
  if new.consent_type = 'vton_processing' and new.granted = false then
    update public.vton_jobs set status = 'cancelled', finished_at = now()
     where user_id = new.user_id and status in ('queued','running');

    v_renders := private.mark_renders_for_purge(new.user_id, null);
    delete from private.body_reference_photos where user_id = new.user_id;

    insert into audit.access_log (actor_user_id, subject_user_id, action, object_type, details)
    values (new.user_id, new.user_id, 'purge_body_photos_on_revocation', 'body_photo',
            jsonb_build_object('renders_purged', v_renders));
  end if;
  return null;
end;
$$;

-- What the retention worker deletes from object storage.
create or replace view public.v_purgeable_media as
select m.id, m.user_id, m.bucket, m.storage_key, m.deleted_at
  from public.media_assets m
 where m.deleted_at is not null;

alter view public.v_purgeable_media set (security_invoker = true);
grant select on public.v_purgeable_media to service_role;
