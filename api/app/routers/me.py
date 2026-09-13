"""Account and consent."""
from __future__ import annotations

from fastapi import APIRouter, status

from ..db import fetch_all, fetch_one
from ..deps import ConnDep, PrincipalDep, SettingsDep
from ..errors import NotFound
from ..schemas import ConsentDecision, ConsentState, User

router = APIRouter(prefix="/v1/me", tags=["Account"])


@router.get("", response_model=User)
async def get_me(conn: ConnDep, principal: PrincipalDep):
    row = await fetch_one(conn, """
        select id, email::text as email, display_name, locale, country_code,
               timezone, units::text as units, onboarding_stage, created_at
          from public.users where id = :id and deleted_at is null
    """, {"id": str(principal.user_id)})
    if row is None:
        raise NotFound("User", str(principal.user_id))
    return dict(row)


@router.get("/consents", response_model=list[ConsentState])
async def list_consents(conn: ConnDep, principal: PrincipalDep):
    rows = await fetch_all(conn, """
        select consent_type::text as consent_type, granted, policy_version, decided_at
          from public.v_user_consent_state
         where user_id = :uid
         order by consent_type
    """, {"uid": str(principal.user_id)})
    return [dict(r) for r in rows]


@router.post("/consents", response_model=ConsentState, status_code=status.HTTP_201_CREATED)
async def record_consent(body: ConsentDecision, conn: ConnDep, principal: PrincipalDep,
                         settings: SettingsDep):
    """Append-only: revoking is a new row, never an update. The ledger is the audit trail."""
    row = await fetch_one(conn, """
        insert into public.user_consents (user_id, consent_type, granted, policy_version, source)
        values (:uid, cast(:ctype as public.consent_type), :granted, :ver, 'app')
        returning consent_type::text as consent_type, granted, policy_version,
                  created_at as decided_at
    """, {"uid": str(principal.user_id), "ctype": body.consent_type,
          "granted": body.granted, "ver": body.policy_version or settings.consent_policy_version})
    return dict(row)
