# Haylou S30 panel

Pannello per configurare le cuffie **Haylou S30 ANC** da computer, dato che l'app
ufficiale esiste solo per telefono.

| | Come | Requisiti |
|---|---|---|
| **Windows** | scarica `HaylouS30.exe` dalle [Release](../../releases/latest) e aprilo | nessuno |
| **Linux** | `python3 server.py --open` | Python 3.9+, BlueZ, PipeWire/PulseAudio |

Si apre un pannello nel browser su http://127.0.0.1:8730. Le cuffie devono essere già
accoppiate e collegate al computer.

La [pagina web](https://josemariasava.github.io/haylou-s30/) ha solo i link di download e il
test microfono: il browser non può comandare le cuffie, perché Chrome/Edge bloccano in
Web Serial i servizi Bluetooth con UUID sulla base SIG, compreso il loro (`0000fd3d-…`).

## Funzioni
- Modalità audio: ANC / trasparenza / off
- Equalizzatore (preset)
- Game mode, multipoint, trova cuffie
- Batteria, firmware
- Test microfono: registra 4 s, misura il livello e lo fa riascoltare.
  Su Windows e nella pagina web si sceglie il microfono: quello giusto per le chiamate
  (Teams ecc.) è il dispositivo **Hands-Free / Auricolare**.
- Su Linux: Collega/Scollega le cuffie (per passarle a un altro computer)

## Linux
`server.py` usa solo la libreria standard. Apre http://127.0.0.1:8730 e si chiude da solo
~90 s dopo la chiusura della pagina. Per l'icona nel menu copia
`linux/haylou-s30.desktop` in `~/.local/share/applications/` (correggi il percorso in `Exec`).
Il test microfono passa temporaneamente al profilo HFP con `pactl` e poi torna ad A2DP.

## Build
- Push su `main` che tocca `static/` → pubblica la pagina su GitHub Pages.
- Tag `v*` → GitHub Actions compila `HaylouS30.exe` con PyInstaller e lo allega alla release.

## Protocollo
Seriale Bluetooth sul servizio `0000fd3d-0000-1000-8000-00805f9b34fb` (JL_SPP, RFCOMM canale 10;
il chip è JieLi). Stesso protocollo delle Haylou S35 ANC supportate da
[Gadgetbridge](https://codeberg.org/Freeyourgadget/Gadgetbridge/pulls/6407).

- Comando: `aabbccc0` + payload + `ddeeff`
- Risposta: `aabbcc00` + opcode + lunghezza (2 byte) + payload + `ddeeff`; esito `0000` = ok
- Messaggi spontanei delle cuffie: header `aabbccc0`
- Info: `02 0005 00 <maschera 32 bit>` → voci TLV (len, tipo, valore): 0 nome, 1 firmware, 2 batteria
- Funzioni: `08 0004 00 02 <feature> <valore>` — 04 ANC (0 off, 1 ANC, 2 trasparenza), 05 game, 09 multipoint
- EQ: `f2 0005 00 03 00 07 <preset>` (0 default, 2 rock, 3 classica, 6 bassi, 7 soft)
- Trova cuffie: `f2 0006 00 04 00 09 <0/1> 03`

Le cuffie non riportano le impostazioni correnti: la pagina mostra le ultime scelte
(salvate in `~/.config/haylou-s30/state.json`, `%APPDATA%\haylou-s30` su Windows).
