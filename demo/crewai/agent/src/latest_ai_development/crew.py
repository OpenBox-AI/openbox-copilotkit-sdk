from crewai import Agent, Crew, Process, Task
from crewai.project import CrewBase, agent, crew, task
from crewai.agents.agent_builder.base_agent import BaseAgent
from typing import List

from .tools.custom_tool import WeatherTool


@CrewBase
class LatestAiDevelopment:
    """LatestAiDevelopment crew"""

    agents: List[BaseAgent]
    tasks: List[Task]
    name: str = "LatestAiDevelopment"

    @agent
    def weather_assistant(self) -> Agent:
        return Agent(
            config=self.agents_config["weather_assistant"],  # type: ignore[index]
            tools=[WeatherTool()],
            verbose=True,
        )

    @task
    def weather_task(self) -> Task:
        return Task(
            config=self.tasks_config["weather_task"],  # type: ignore[index]
        )

    @crew
    def crew(self) -> Crew:
        """Creates the LatestAiDevelopment crew"""
        return Crew(
            name=self.name,
            agents=self.agents,  # Automatically created by the @agent decorator
            tasks=self.tasks,  # Automatically created by the @task decorator
            process=Process.sequential,
            verbose=True,
            chat_llm="gpt-4o",
        )
