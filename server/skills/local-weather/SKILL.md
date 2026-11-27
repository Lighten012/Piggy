---
name: local-weather
description: 回答当地天气、出门是否带伞和穿衣等实时天气问题。
---

用户询问“我这里”“今天出门”等当地天气时先调用 `get_local_weather`。按返回的日期、逐小时天气和单位解读预报，注明 [MET Norway](https://api.met.no/weatherapi/locationforecast/2.0/documentation) 来源。定位不可用且对话里没有明确地点时再问城市。用户明确说了城市或目的地时，优先按那个地点联网核实。天气源访问失败时如实说明，有明确地点可改用网页搜索。区分预报与官方发布的预警。
