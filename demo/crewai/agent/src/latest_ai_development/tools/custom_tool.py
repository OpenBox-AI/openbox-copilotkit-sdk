from crewai.tools import BaseTool
from typing import Type
from pydantic import BaseModel, Field
import requests

_WEATHER_CODES = {
    0: "Clear sky",
    1: "Mainly clear",
    2: "Partly cloudy",
    3: "Overcast",
    45: "Foggy",
    48: "Depositing rime fog",
    51: "Light drizzle",
    53: "Moderate drizzle",
    55: "Dense drizzle",
    56: "Light freezing drizzle",
    57: "Dense freezing drizzle",
    61: "Slight rain",
    63: "Moderate rain",
    65: "Heavy rain",
    66: "Light freezing rain",
    67: "Heavy freezing rain",
    71: "Slight snow fall",
    73: "Moderate snow fall",
    75: "Heavy snow fall",
    77: "Snow grains",
    80: "Slight rain showers",
    81: "Moderate rain showers",
    82: "Violent rain showers",
    85: "Slight snow showers",
    86: "Heavy snow showers",
    95: "Thunderstorm",
    96: "Thunderstorm with slight hail",
    99: "Thunderstorm with heavy hail",
}


class WeatherToolInput(BaseModel):
    """Input schema for WeatherTool."""

    location: str = Field(..., description="City name to get the weather for.")


class WeatherTool(BaseTool):
    name: str = "get_weather"
    description: str = "Get the current weather for a given location (city name)."
    args_schema: Type[BaseModel] = WeatherToolInput

    def _run(self, location: str) -> str:
        geocoding = requests.get(
            "https://geocoding-api.open-meteo.com/v1/search",
            params={"name": location, "count": 1},
            timeout=15,
        ).json()

        results = geocoding.get("results")
        if not results:
            return f"Location '{location}' not found."

        place = results[0]
        current = requests.get(
            "https://api.open-meteo.com/v1/forecast",
            params={
                "latitude": place["latitude"],
                "longitude": place["longitude"],
                "current": "temperature_2m,apparent_temperature,relative_humidity_2m,wind_speed_10m,wind_gusts_10m,weather_code",
            },
            timeout=15,
        ).json()["current"]

        conditions = _WEATHER_CODES.get(current["weather_code"], "Unknown")
        return (
            f"Current weather in {place['name']}: {conditions}, "
            f"{current['temperature_2m']}°C (feels like {current['apparent_temperature']}°C), "
            f"humidity {current['relative_humidity_2m']}%, "
            f"wind {current['wind_speed_10m']} km/h (gusts {current['wind_gusts_10m']} km/h)."
        )
