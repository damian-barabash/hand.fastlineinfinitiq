# AI Łowca Leadów (Hand) — jak to wdrożyć i niczego nie zepsuć

Repozytorium: `hand.fastlineinfinitiq` → domena **hand.fastlineinfinitiq.pl** (GitHub Pages).
Wszystko poniżej robisz raz. Potem każdy `git push` na `main` sam publikuje stronę.

---

## 1. Pierwsze wypchnięcie kodu

```bash
cd "/Users/dmytrii/Desktop/PROJEKTY/FASTLINE INFINITIQ/Prod/hand.fastlineinfinitiq"
git add -A
git commit -m "AI Łowca Leadów: panel, silnik hand-api, integracje"
git push -u origin main
```

Jeśli `git push` powie, że zdalne repo ma inną historię (bo tworzyłeś je z README):

```bash
git pull --rebase origin main
git push -u origin main
```

## 2. Włączenie GitHub Pages (raz)

W repozytorium na GitHubie: **Settings → Pages → Build and deployment → Source: GitHub Actions**.
Workflow `.github/workflows/deploy.yml` jest już w repo — po pierwszym pushu zbuduje i opublikuje.
Plik `public/CNAME` z treścią `hand.fastlineinfinitiq.pl` jedzie razem z buildem, więc domena
podepnie się sama.

## 3. DNS (raz)

W panelu domeny `fastlineinfinitiq.pl` dodaj rekord:

```
CNAME   hand   damian-barabash.github.io.
```

Dokładnie tak jak dla `brain`. Certyfikat GitHub wystawia sam, zwykle w 10–30 minut.
W **Settings → Pages** po podpięciu zaznacz **Enforce HTTPS**.

## 4. Co już jest zrobione po stronie serwera (nie ruszaj)

| Rzecz | Stan |
|---|---|
| Funkcja `hand-api` | wdrożona (v7), `verify_jwt: false` |
| Sekret `HAND_CRON_KEY` | ustawiony |
| Sekret `GOOGLE_MAPS_KEY` | ustawiony (Twój klucz) |
| Cron `hand-tick` | co minutę, wysyłka w limitach |
| Tabele `hand_*`, `fiq_*`, `brain_user_projects` | utworzone, RLS deny-all |
| Produkt `hand` w `fiq_products` | aktywny, przypisany do workspace FRA |

## 5. Co musisz zrobić Ty, żeby agent ruszył

1. **Google Places** — wejdź na
   <https://console.cloud.google.com/apis/library/places.googleapis.com?project=95214760119>
   i kliknij **Enable**. Klucz już działa, brakuje tylko włączonego API.
   Sprawdzisz w panelu: *Admin → Integracje → Google Places → Sprawdź klucz*.
2. **Unipile** — załóż konto, podłącz tam konta LinkedIn, potem w panelu:
   *Admin → Integracje → Unipile* wklej **DSN** (np. `api8.unipile.com:13843`) i **token**.
   Kliknij *Zapisz i sprawdź* — pokaże listę kont.
3. **Konto LinkedIn dla projektu** — w AI Łowca Leadów: *Integracje → Konto LinkedIn tego projektu*
   → *Pobierz konta* → *Użyj*. Widzi to tylko admin.
4. **Autopilot** — *Ustawienia → Włącz autopilota*. Do tego czasu agent tylko szuka
   i pokazuje leady, sam nikogo nie zaczepia.

## 6. Jak wydać zmianę w kodzie później

```bash
npm run sync:shared     # tylko jeśli zmieniałeś fiq-shared
npm run build           # sprawdzenie, że się buduje
git add -A && git commit -m "…" && git push
```

Zmiana w `supabase/functions/hand-api/index.ts` **nie** jedzie z GitHub Pages — funkcję
wdraża się osobno (Management API, tak jak `brain-admin`). Zawsze najpierw type-check:

```bash
~/.deno/bin/deno check supabase/functions/hand-api/index.ts
```

> Uwaga z doświadczenia: polski cudzysłów „ ” wewnątrz stringa w podwójnych cudzysłowach
> rozwala plik, a deploy zwraca wtedy `vNone` i **cicho zostawia starą wersję**.
> Nigdy nie wdrażaj bez `deno check`.

## 7. Warstwa wspólna (`fiq-shared`)

Katalog `src/shared/` to **kopia** z `../fiq-shared/src` — nie edytuj go w tym repo.
Zmieniasz w `fiq-shared`, potem w każdym produkcie `npm run sync:shared` i commit.
Kopia jest w repozytorium celowo: GitHub Actions nie ma dostępu do `fiq-shared`,
więc build na CI musi mieć te pliki u siebie.
