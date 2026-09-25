# Bologna tram traffic

A morning-peak model of Bologna’s **Linea Rossa**: Borgo Panigale through the historic centre, then out to the Fiera (Michelino) and to the Faculty of Agriculture at Pilastro.

The map shows the corridor **before** the tram (cars, buses, bicycles) and **with** the tram. Pick a model, then move the sliders for how many drivers switch and how often the tram runs.

## Run

```bash
npm install
python3.12 -m venv .venv
.venv/bin/pip install -r requirements.txt
npm test
npm run models
npm run dev
```

Open the URL Vite prints (http://localhost:5173).

The page reads `public/catalog.json`, a grid of saved runs. For a slider position that is not on that grid, start the model server and the page will compute it:

```bash
npm run serve-models
```

That listens on http://127.0.0.1:8765.

## Models

- **Volume-delay.** A BPR curve plus Webster delay at each signal. Every car trip is assigned; a crowded street gets slower.
- **Cell transmission.** Daganzo’s cell model. Signals stop the cells on red. If demand is above what the greens can clear, fewer cars get through San Felice.
- **Car following.** The Intelligent Driver Model, with buses dwelling at stops and bicycles either on a cycle track or in the traffic.
- **Neural surrogate.** A 12-neuron network trained on cell-transmission runs of this corridor. The holdout error, in minutes per street, is shown in the assumptions.

Cell transmission and car following are [Warp](https://nvidia.github.io/warp/) kernels. On an NVIDIA GPU those kernels compile to CUDA. This Mac has no CUDA device, so here they run on Warp’s CPU, and the catalog numbers come from the NumPy twin of the same update. The tests check that the Warp update matches NumPy.

## What the scenario does

Eastbound traffic in the weekday morning peak.

- Demand, buses, bicycle counts, and signal positions come from the open data below. Signal *timings* are not published: each junction is a 90 second cycle with 40 seconds of green for the corridor.
- **Before:** cars and the buses that pass Porta San Felice share the street. Bicycles use the corridor, including the centre.
- **With the tram:** those buses leave the alignment, a chosen share of drivers switch, and streets where the tracks run give up a lane. Cars go around the historic centre on the avenues. The tram runs on a timetable (about 7.6 m/s, 26 seconds at each stop). Bicycles stay.

Published checks for the real line: about 16.5 km, a tram every 4–5 minutes, about 40 minutes from Borgo Panigale to the Fiera and 52 minutes to Agraria. Passenger service is expected in 2027.

This is a scenario, not a forecast from the Comune di Bologna.

## Data

| Source | Use | Licence |
| --- | --- | --- |
| OpenStreetMap | Street geometry, traffic-signal positions, cycleways, bus stops | ODbL |
| Comune di Bologna, `traffico-viali` | Weekday 08:00–09:00 boulevard counts | Comune open data |
| Comune di Bologna, `colonnine-conta-bici` | Bicycle counter nearest the corridor | Comune open data |
| TPER GTFS (`gommagtfsbo`) | Buses at Porta San Felice, Wednesday morning | CC BY 3.0 IT |

The boulevard counters sit on the ring, not on Via Emilia. The corridor demand is the peak direction at Viale Pietramellara and Viale Ercolani. Refresh the extract with:

```bash
.venv/bin/python scripts/fetch_supply.py
npm run catalog
```

`scripts/build_network.py` rebuilds `public/network.json` from named OpenStreetMap streets.
